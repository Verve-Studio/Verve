import React, { useEffect, useState } from "react";
import { stampCloneSegment } from "./cloneStampStroke";
import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { notificationStore } from "@/core/store/notificationStore";

import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import cloneStampIconSvg from "./clone-stamp.svg?raw";
import { activeScope } from "@/core/store/scope";

// ─── Module-level options ────────────────────────────────────────────────────

export const cloneStampOptions = {
  size: 20,
  hardness: 80,
  opacity: 100,
  aligned: true,
  sampleAllLayers: false,
};

// ─── Handler ─────────────────────────────────────────────────────────────────

function createCloneStampHandler(): ToolHandler {
  let lastPos: { x: number; y: number } | null = null;
  let touched: import("../_shared/primitives").TouchedBuffer | null = null;
  let sourceBuffer: Uint8Array | Float32Array | null = null;
  let sourceBounds: {
    offsetX: number;
    offsetY: number;
    layerWidth: number;
    layerHeight: number;
  } | null = null;
  let strokeOffsetDX = 0;
  let strokeOffsetDY = 0;
  let isStrokeReady = false;
  let strokeToken: symbol | null = null;
  // Sample-all-layers: segments drawn before the async composite readback
  // resolves are queued and painted once it arrives (a quick tap used to
  // paint nothing), and a pointer-up that comes first defers the stroke end.
  let pendingSegments: Array<[number, number, number, number]> = [];
  let upBeforeReady = false;
  // A different source layer is read live (it isn't modified by the
  // stroke); `layer.data` is re-read per segment because WASM heap growth
  // replaces it.
  let liveSourceLayer: GpuLayer | null = null;

  function paintSegment(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    ctx: ToolContext,
  ): void {
    const { renderer, layer, layers, selectionMask, render, growLayerToFit } =
      ctx;
    const pad = Math.ceil(cloneStampOptions.size / 2) + 2;
    growLayerToFit(x0, y0, pad);
    growLayerToFit(x1, y1, pad);
    // Re-read AFTER growing: the grow allocates on the WASM heap, and a heap
    // growth detaches every earlier view — a source view taken before it
    // reads as empty and painted transparent holes for the rest of the
    // segment.
    if (liveSourceLayer) sourceBuffer = liveSourceLayer.data;

    const sel = selectionMask
      ? { mask: selectionMask, width: renderer.pixelWidth }
      : undefined;

    const tiledW = ctx.tiledMode ? renderer.pixelWidth : undefined;
    const tiledH = ctx.tiledMode ? renderer.pixelHeight : undefined;

    stampCloneSegment(
      renderer,
      layer,
      x0,
      y0,
      x1,
      y1,
      cloneStampOptions.size,
      cloneStampOptions.hardness,
      strokeOffsetDX,
      strokeOffsetDY,
      sourceBuffer!,
      sourceBounds === null,
      sourceBounds,
      renderer.pixelWidth,
      renderer.pixelHeight,
      cloneStampOptions.opacity,
      touched ?? undefined,
      sel,
      tiledW,
      tiledH,
    );

    // In tiled mode, stampCloneSegment wraps writes to the opposing edge of
    // the layer, far from the unwrapped (x0..x1) bounding box. A bounded
    // dirtyRect would miss those writes; leave it null for a full upload.
    if (!ctx.tiledMode) {
      const lx = Math.max(
        0,
        Math.floor(Math.min(x0, x1) - layer.offsetX) - pad,
      );
      const ly = Math.max(
        0,
        Math.floor(Math.min(y0, y1) - layer.offsetY) - pad,
      );
      const rx = Math.min(
        layer.layerWidth,
        Math.ceil(Math.max(x0, x1) - layer.offsetX) + pad + 1,
      );
      const ry = Math.min(
        layer.layerHeight,
        Math.ceil(Math.max(y0, y1) - layer.offsetY) + pad + 1,
      );
      renderer.markDirtyRect(layer, lx, ly, rx, ry);
    }

    renderer.flushLayer(layer);
    render(layers);
  }

  /** End the stroke; `commit` records history (deferred-stroke path). */
  function finishStroke(ctx: ToolContext, commit: boolean): void {
    strokeToken = null;
    lastPos = null;
    touched = null;
    sourceBuffer = null;
    sourceBounds = null;
    liveSourceLayer = null;
    pendingSegments = [];
    upBeforeReady = false;
    isStrokeReady = false;
    ctx.renderer.strokeEnd();
    if (commit) ctx.commitStroke("Clone-stamp");
  }

  return {
    onPointerDown({ x, y, altKey }: ToolPointerPos, ctx: ToolContext) {
      if (altKey) {
        const { layers } = ctx;
        let hitLayerId = ctx.layer.id;
        for (let i = layers.length - 1; i >= 0; i--) {
          const l = layers[i];
          if (!l.visible) continue;
          const lx = Math.round(x) - l.offsetX;
          const ly = Math.round(y) - l.offsetY;
          if (lx >= 0 && ly >= 0 && lx < l.layerWidth && ly < l.layerHeight) {
            const px = ly * l.layerWidth + lx;
            const opaque =
              l.format === "indexed8"
                ? l.data[px] !== 255
                : l.data[px * 4 + 3] > 0;
            if (opaque) {
              hitLayerId = l.id;
              break;
            }
          }
        }
        ctx.scope.cloneStamp.setSource(x, y, hitLayerId);
        return;
      }

      const cs = ctx.scope.cloneStamp;
      const source = cs.source;
      if (!source) return;
      // Validate the source before starting a stroke (a deleted source layer
      // used to start a stroke that painted nothing but still hit history).
      const sourceLayer = cloneStampOptions.sampleAllLayers
        ? null
        : (ctx.layers.find((l) => l.id === source.layerId) ?? null);
      if (!cloneStampOptions.sampleAllLayers && !sourceLayer) {
        notificationStore.error(
          "The clone source layer no longer exists — Alt-click to set a new source.",
        );
        return;
      }

      ctx.renderer.strokeStart();

      if (cloneStampOptions.aligned) {
        if (!cs.alignedOffset) {
          cs.alignedOffset = {
            dx: source.x - x,
            dy: source.y - y,
          };
        }
        strokeOffsetDX = cs.alignedOffset.dx;
        strokeOffsetDY = cs.alignedOffset.dy;
      } else {
        strokeOffsetDX = source.x - x;
        strokeOffsetDY = source.y - y;
      }

      touched = ctx.renderer.acquireTouchedBuffer();
      lastPos = { x, y };
      isStrokeReady = false;
      sourceBuffer = null;
      sourceBounds = null;
      liveSourceLayer = null;
      pendingSegments = [];
      upBeforeReady = false;

      if (cloneStampOptions.sampleAllLayers) {
        const capturedCtx = ctx;
        const token = Symbol();
        strokeToken = token;
        pendingSegments.push([x, y, x, y]);
        ctx
          .readCompositePixels()
          .then((buf) => {
            if (strokeToken !== token) return;
            sourceBuffer = buf;
            sourceBounds = null;
            isStrokeReady = true;
            for (const [x0, y0, x1, y1] of pendingSegments) {
              paintSegment(x0, y0, x1, y1, capturedCtx);
            }
            pendingSegments = [];
            if (upBeforeReady) finishStroke(capturedCtx, true);
          })
          .catch((err: unknown) => {
            if (strokeToken !== token) return;
            notificationStore.error(
              `Clone Stamp could not sample the image: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            if (upBeforeReady) finishStroke(capturedCtx, false);
          });
      } else if (sourceLayer) {
        if (sourceLayer === ctx.layer) {
          // Cloning within the layer being painted: sample a stable copy.
          sourceBuffer = ctx.renderer.readLayerPixels(sourceLayer);
        } else {
          liveSourceLayer = sourceLayer;
          sourceBuffer = sourceLayer.data;
        }
        sourceBounds = {
          offsetX: sourceLayer.offsetX,
          offsetY: sourceLayer.offsetY,
          layerWidth: sourceLayer.layerWidth,
          layerHeight: sourceLayer.layerHeight,
        };
        isStrokeReady = true;
        paintSegment(x, y, x, y, ctx);
      }
    },

    onPointerMove({ x, y }: ToolPointerPos, ctx: ToolContext) {
      if (!lastPos) return;
      if (!isStrokeReady) {
        // Readback still pending: queue the segment.
        if (strokeToken) pendingSegments.push([lastPos.x, lastPos.y, x, y]);
        lastPos = { x, y };
        return;
      }
      if (!sourceBuffer) return;
      paintSegment(lastPos.x, lastPos.y, x, y, ctx);
      lastPos = { x, y };
      if (cloneStampOptions.aligned && ctx.scope.cloneStamp.alignedOffset) {
        ctx.scope.cloneStamp.notify();
      }
    },

    onPointerUp({ x, y }: ToolPointerPos, ctx: ToolContext) {
      // Alt-click (source pick) or a click with no source set: no stroke was
      // started, so there is nothing to record.
      if (!lastPos) return { skipHistory: true };
      if (!isStrokeReady && strokeToken) {
        // Composite readback still in flight: paint the queued segments
        // when it lands, then end the stroke and commit history ourselves.
        pendingSegments.push([lastPos.x, lastPos.y, x, y]);
        lastPos = null;
        upBeforeReady = true;
        return { skipHistory: true };
      }
      if (isStrokeReady && sourceBuffer) {
        paintSegment(lastPos.x, lastPos.y, x, y, ctx);
      }
      finishStroke(ctx, false);
    },

    onCancel() {
      strokeToken = null;
      lastPos = null;
      touched = null;
      sourceBuffer = null;
      sourceBounds = null;
      liveSourceLayer = null;
      pendingSegments = [];
      upBeforeReady = false;
      isStrokeReady = false;
    },

    onHover() {
      if (activeScope().cloneStamp.source !== null) {
        activeScope().cloneStamp.notify();
      }
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function CloneStampOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [size, setSize] = useState(cloneStampOptions.size);
  const [hardness, setHardness] = useState(cloneStampOptions.hardness);
  const [opacity, setOpacity] = useState(cloneStampOptions.opacity);
  const [aligned, setAligned] = useState(cloneStampOptions.aligned);
  const [sampleAllLayers, setSampleAllLayers] = useState(
    cloneStampOptions.sampleAllLayers,
  );
  const [source, setSource] = useState(activeScope().cloneStamp.source);

  useEffect(() => {
    const update = (): void => setSource(activeScope().cloneStamp.source);
    activeScope().cloneStamp.subscribe(update);
    return () => activeScope().cloneStamp.unsubscribe(update);
  }, []);

  const handleSize = (v: number): void => {
    cloneStampOptions.size = v;
    setSize(v);
  };
  const handleHardness = (v: number): void => {
    cloneStampOptions.hardness = v;
    setHardness(v);
  };
  const handleOpacity = (v: number): void => {
    cloneStampOptions.opacity = v;
    setOpacity(v);
  };
  const handleAligned = (v: boolean): void => {
    cloneStampOptions.aligned = v;
    setAligned(v);
  };
  const handleSampleAll = (v: boolean): void => {
    cloneStampOptions.sampleAllLayers = v;
    setSampleAllLayers(v);
  };

  return (
    <>
      <label className={styles.optLabel}>Size:</label>
      <SliderInput
        value={size}
        min={1}
        max={500}
        inputWidth={42}
        onChange={handleSize}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Hardness:</label>
      <SliderInput
        value={hardness}
        min={0}
        max={100}
        suffix="%"
        inputWidth={42}
        onChange={handleHardness}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Opacity:</label>
      <SliderInput
        value={opacity}
        min={1}
        max={100}
        suffix="%"
        inputWidth={42}
        onChange={handleOpacity}
      />
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={aligned}
          onChange={(e) => handleAligned(e.target.checked)}
        />
        Aligned
      </label>
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={sampleAllLayers}
          onChange={(e) => handleSampleAll(e.target.checked)}
        />
        Sample All Layers
      </label>
      <span className={styles.optSep} />
      <span style={source ? SOURCE_SET_STYLE : NO_SOURCE_STYLE}>
        <span style={SOURCE_DOT_STYLE} />
        {source
          ? `Source @ (${Math.round(source.x)}, ${Math.round(source.y)})`
          : "No source — Alt+click to set"}
      </span>
    </>
  );
}

const NO_SOURCE_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  fontSize: 10,
  padding: "2px 7px",
  borderRadius: 2,
  whiteSpace: "nowrap",
  flexShrink: 0,
  color: "var(--color-text-muted)",
};

const SOURCE_SET_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  fontSize: 10,
  padding: "2px 7px",
  borderRadius: 2,
  whiteSpace: "nowrap",
  flexShrink: 0,
  color: "var(--color-accent)",
  background: "var(--color-accent-glow)",
  border: "1px solid var(--color-accent-border)",
};

const SOURCE_DOT_STYLE: React.CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: "50%",
  background: "currentColor",
  flexShrink: 0,
  display: "inline-block",
};

class CloneStampTool implements ITool {
  readonly id = "clone-stamp";
  readonly label = "Clone Stamp";
  readonly shortcut = "S";
  readonly icon = <SvgIcon src={cloneStampIconSvg} />;
  readonly placement = {
    group: ToolGroup.Retouching,
    row: 0,
    column: 0,
  } as const;
  readonly releaseOnEscape = true;
  readonly modifiesPixels = true;
  readonly paintsOntoPixelLayer = true;
  readonly pixelOnly = true;
  readonly indexed8Unsupported = true;
  createHandler(): ToolHandler {
    return createCloneStampHandler();
  }
  readonly Options = CloneStampOptions;
}

export const cloneStampTool: ITool = new CloneStampTool();
