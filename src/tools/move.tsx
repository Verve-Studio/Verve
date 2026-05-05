import React, { useEffect, useState } from "react";
import { selectionStore } from "@/core/store/selectionStore";
import type { Guide, TextLayerState, ShapeLayerState } from "@/types";
import type {
  GpuLayer,
  WebGPURenderer,
} from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import type {
  ToolDefinition,
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "./types";

// ─── Snap-to-guide options ────────────────────────────────────────────────────

export type SnapPoint =
  | "center"
  | "upper-left"
  | "upper-right"
  | "lower-left"
  | "lower-right"
  | "vertical-middle"
  | "horizontal-middle";

export const moveOptions = {
  snapToGuide: false,
  snapPoint: "upper-left" as SnapPoint,
};

const SNAP_THRESHOLD_CSS_PX = 8;

interface VisibleBounds {
  /** Inclusive min X in layer-local space */
  minX: number;
  /** Inclusive min Y in layer-local space */
  minY: number;
  /** Exclusive max X in layer-local space */
  maxX: number;
  /** Exclusive max Y in layer-local space */
  maxY: number;
}

/**
 * Computes the tight bounding box of non-transparent pixels in layer-local space.
 * Falls back to the full layer rect if the layer is entirely transparent.
 */
function getVisibleBounds(
  data: Uint8Array | Float32Array,
  w: number,
  h: number,
  format: string,
): VisibleBounds {
  let minX = w,
    minY = h,
    maxX = 0,
    maxY = 0;
  if (format === "rgba32f") {
    const d = data as Float32Array;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x + 1 > maxX) maxX = x + 1;
          if (y < minY) minY = y;
          if (y + 1 > maxY) maxY = y + 1;
        }
      }
    }
  } else if (format === "indexed8") {
    const d = data as Uint8Array;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[y * w + x] !== 255) {
          if (x < minX) minX = x;
          if (x + 1 > maxX) maxX = x + 1;
          if (y < minY) minY = y;
          if (y + 1 > maxY) maxY = y + 1;
        }
      }
    }
  } else {
    // rgba8
    const d = data as Uint8Array;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x + 1 > maxX) maxX = x + 1;
          if (y < minY) minY = y;
          if (y + 1 > maxY) maxY = y + 1;
        }
      }
    }
  }
  // All transparent — fall back to full rect
  if (maxX === 0 || maxY === 0) return { minX: 0, minY: 0, maxX: w, maxY: h };
  return { minX, minY, maxX, maxY };
}

/**
 * Returns the canvas-space offset of the snap anchor from offsetX/offsetY
 * given the visible bounding box (layer-local coords).
 */
function getAnchorOffset(
  bounds: VisibleBounds,
  snapPoint: SnapPoint,
): [number, number] {
  const { minX, minY, maxX, maxY } = bounds;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  switch (snapPoint) {
    case "upper-left":
      return [minX, minY];
    case "upper-right":
      return [maxX, minY];
    case "lower-left":
      return [minX, maxY];
    case "lower-right":
      return [maxX, maxY];
    case "center":
      return [cx, cy];
    case "vertical-middle":
      return [cx, minY]; // top-center edge
    case "horizontal-middle":
      return [minX, cy]; // left-center edge
  }
}

/**
 * Adjusts dx/dy so that the chosen snap-point of the visible pixel bounds
 * snaps to the nearest guide within the threshold. Only operates on
 * whole-layer moves (not selection or text/shape moves).
 */
function snapDelta(
  origX: number,
  origY: number,
  dx: number,
  dy: number,
  bounds: VisibleBounds,
  guides: Guide[],
  zoom: number,
): [number, number] {
  if (!moveOptions.snapToGuide || guides.length === 0) return [dx, dy];
  const dpr = window.devicePixelRatio || 1;
  const threshold = SNAP_THRESHOLD_CSS_PX / (zoom / dpr);
  const [anchorOffX, anchorOffY] = getAnchorOffset(
    bounds,
    moveOptions.snapPoint,
  );
  const anchorX = origX + dx + anchorOffX;
  const anchorY = origY + dy + anchorOffY;
  let snappedDx = dx;
  let snappedDy = dy;
  let minDistX = threshold;
  let minDistY = threshold;
  for (const g of guides) {
    if (g.axis === "v") {
      const d = Math.abs(anchorX - g.position);
      if (d < minDistX) {
        minDistX = d;
        snappedDx = g.position - anchorOffX - origX;
      }
    } else {
      const d = Math.abs(anchorY - g.position);
      if (d < minDistY) {
        minDistY = d;
        snappedDy = g.position - anchorOffY - origY;
      }
    }
  }
  return [snappedDx, snappedDy];
}

// ─── Display store (live position/size for options bar) ───────────────────────

const moveDisplay = {
  x: null as number | null,
  y: null as number | null,
  w: null as number | null,
  h: null as number | null,
  listeners: new Set<() => void>(),
  subscribe(fn: () => void): void {
    this.listeners.add(fn);
  },
  unsubscribe(fn: () => void): void {
    this.listeners.delete(fn);
  },
  /**
   * X/Y: top-left of the layer in canvas-space (origin = canvas top-left).
   * W/H: pixel dimensions of the layer content.
   */
  set(offsetX: number, offsetY: number, layerW: number, layerH: number): void {
    this.x = offsetX;
    this.y = offsetY;
    this.w = layerW;
    this.h = layerH;
    this.listeners.forEach((fn) => fn());
  },
};

// ─── Handler ──────────────────────────────────────────────────────────────────

function translateShapeLayer(
  ls: ShapeLayerState,
  dx: number,
  dy: number,
): ShapeLayerState {
  if (ls.shapeType === "line") {
    return {
      ...ls,
      x1: ls.x1 + dx,
      y1: ls.y1 + dy,
      x2: ls.x2 + dx,
      y2: ls.y2 + dy,
    };
  }
  return { ...ls, cx: ls.cx + dx, cy: ls.cy + dy };
}

function createMoveHandler(): ToolHandler {
  let startX = 0;
  let startY = 0;
  let lastDx = 0;
  let lastDy = 0;
  // For selection move: full pixel copy per-drag
  let originalPixels: Uint8Array | Float32Array | null = null;
  let originalMask: Uint8Array | null = null;
  // For whole-layer move: store original offset of the active layer
  let originalOffsetX = 0;
  let originalOffsetY = 0;
  // For multi-layer move: original offsets for ALL selected layers (keyed by layer id)
  let multiOriginalOffsets: Map<string, { x: number; y: number }> | null = null;
  // For text layer move: track original ls.x / ls.y
  let textLayerSnapshot: TextLayerState | null = null;
  let textLayerOrigX = 0;
  let textLayerOrigY = 0;
  // For shape layer move: track original parametric coords
  let shapeLayerSnapshot: ShapeLayerState | null = null;
  // For whole-layer move: snapshot of the mask pixel data at pointer-down
  let originalMaskData: Uint8Array | null = null;
  let isDown = false;
  // Cached visible-pixel bounding box for snap-to-guide (computed at pointer-down)
  let cachedVisibleBounds: VisibleBounds | null = null;
  // When true, cachedVisibleBounds is already in canvas-space (pass origX=0/origY=0 to snapDelta)
  let boundsAreCanvasSpace = false;

  /**
   * Shift a full-canvas RGBA mask layer's pixel data by (dx, dy) relative to
   * `originalMaskData` (the snapshot taken at pointer-down) and flush to GPU.
   * This keeps the mask spatially aligned with its parent layer as it moves.
   */
  function applyMaskShift(
    dx: number,
    dy: number,
    maskLayer: GpuLayer,
    renderer: WebGPURenderer,
  ): void {
    if (!originalMaskData) return;
    const w = renderer.pixelWidth;
    const h = renderer.pixelHeight;
    const dst = maskLayer.data as Uint8Array;
    dst.fill(0);
    for (let sy = 0; sy < h; sy++) {
      const ty = sy + dy;
      if (ty < 0 || ty >= h) continue;
      for (let sx = 0; sx < w; sx++) {
        const tx = sx + dx;
        if (tx < 0 || tx >= w) continue;
        const si = (sy * w + sx) * 4;
        const di = (ty * w + tx) * 4;
        dst[di] = originalMaskData[si];
        dst[di + 1] = originalMaskData[si + 1];
        dst[di + 2] = originalMaskData[si + 2];
        dst[di + 3] = originalMaskData[si + 3];
      }
    }
    renderer.flushLayer(maskLayer);
  }

  function applySelectionMove(dx: number, dy: number, ctx: ToolContext): void {
    const { renderer, layer, layers, render } = ctx;
    const w = renderer.pixelWidth;
    const h = renderer.pixelHeight;
    const lw = layer.layerWidth;
    const lh = layer.layerHeight;
    const src = originalPixels!;
    const dst = layer.data;

    // Step 1: restore original pixels
    dst.set(src);
    // Step 2: erase selected pixels from their original position (in layer-local coords)
    for (let i = 0; i < w * h; i++) {
      const a = originalMask![i];
      if (a === 0) continue;
      const cx = i % w;
      const cy = Math.floor(i / w);
      const lx = cx - layer.offsetX;
      const ly = cy - layer.offsetY;
      if (lx < 0 || ly < 0 || lx >= lw || ly >= lh) continue;
      const pi = (ly * lw + lx) * 4;
      const f = 1 - a / 255;
      dst[pi] = Math.round(dst[pi] * f);
      dst[pi + 1] = Math.round(dst[pi + 1] * f);
      dst[pi + 2] = Math.round(dst[pi + 2] * f);
      dst[pi + 3] = Math.round(dst[pi + 3] * f);
    }
    // Step 3: composite selected pixels at the new position (over)
    for (let sy = 0; sy < h; sy++) {
      const ty = sy + dy;
      if (ty < 0 || ty >= h) continue;
      for (let sx = 0; sx < w; sx++) {
        const tx = sx + dx;
        if (tx < 0 || tx >= w) continue;
        const mi = sy * w + sx;
        const a = originalMask![mi];
        if (a === 0) continue;
        const slx = sx - layer.offsetX;
        const sly = sy - layer.offsetY;
        if (slx < 0 || sly < 0 || slx >= lw || sly >= lh) continue;
        const si = (sly * lw + slx) * 4;
        const tlx = tx - layer.offsetX;
        const tly = ty - layer.offsetY;
        if (tlx < 0 || tly < 0 || tlx >= lw || tly >= lh) continue;
        const di = (tly * lw + tlx) * 4;
        const srcA = (src[si + 3] * a) / 255;
        const dstA = dst[di + 3];
        const outA = srcA + dstA * (1 - srcA / 255);
        if (outA === 0) continue;
        dst[di] = Math.round(
          (src[si] * srcA + dst[di] * dstA * (1 - srcA / 255)) / outA,
        );
        dst[di + 1] = Math.round(
          (src[si + 1] * srcA + dst[di + 1] * dstA * (1 - srcA / 255)) / outA,
        );
        dst[di + 2] = Math.round(
          (src[si + 2] * srcA + dst[di + 2] * dstA * (1 - srcA / 255)) / outA,
        );
        dst[di + 3] = Math.min(255, Math.round(outA));
      }
    }

    renderer.flushLayer(layer);
    render(layers);
  }

  return {
    onPointerDown({ x, y }: ToolPointerPos, ctx: ToolContext) {
      startX = Math.round(x);
      startY = Math.round(y);
      lastDx = 0;
      lastDy = 0;
      isDown = true;
      textLayerSnapshot =
        ctx.textLayers.find((t) => t.id === ctx.layer.id) ?? null;
      shapeLayerSnapshot =
        ctx.shapeLayers.find((s) => s.id === ctx.layer.id) ?? null;

      if (selectionStore.mask) {
        // Selection move: pixel-copy approach (selection moves pixels, offset unchanged)
        originalPixels = ctx.layer.data.slice();
        originalMask = selectionStore.mask.slice();
        originalOffsetX = 0;
        originalOffsetY = 0;
        multiOriginalOffsets = null;
        cachedVisibleBounds = null;
      } else {
        // Whole-layer move: just update the offset
        originalPixels = null;
        originalMask = null;
        originalOffsetX = ctx.layer.offsetX;
        originalOffsetY = ctx.layer.offsetY;
        cachedVisibleBounds = getVisibleBounds(
          ctx.layer.data,
          ctx.layer.layerWidth,
          ctx.layer.layerHeight,
          ctx.layer.format,
        );
        // Snapshot the mask's pixel data so we can shift it during drag
        const maskGl = ctx.maskMap.get(ctx.layer.id);
        originalMaskData = maskGl ? (maskGl.data as Uint8Array).slice() : null;
        if (textLayerSnapshot) {
          textLayerOrigX = textLayerSnapshot.x;
          textLayerOrigY = textLayerSnapshot.y;
        }
        // Capture offsets for all additional selected layers
        const extraIds = ctx.selectedLayerIds.filter(
          (id) => id !== ctx.layer.id,
        );
        if (extraIds.length > 0) {
          multiOriginalOffsets = new Map();
          multiOriginalOffsets.set(ctx.layer.id, {
            x: originalOffsetX,
            y: originalOffsetY,
          });
          for (const id of extraIds) {
            const gl = ctx.layers.find((l) => l.id === id);
            if (gl)
              multiOriginalOffsets.set(id, { x: gl.offsetX, y: gl.offsetY });
          }
          // Compute union of visible-pixel bounds in canvas-space across all selected layers
          const allLayers = [
            ctx.layer,
            ...(extraIds
              .map((id) => ctx.layers.find((l) => l.id === id))
              .filter(Boolean) as (typeof ctx.layer)[]),
          ];
          let uMinX = Infinity,
            uMinY = Infinity,
            uMaxX = -Infinity,
            uMaxY = -Infinity;
          for (const gl of allLayers) {
            const b = getVisibleBounds(
              gl.data,
              gl.layerWidth,
              gl.layerHeight,
              gl.format,
            );
            const ox = gl.offsetX,
              oy = gl.offsetY;
            uMinX = Math.min(uMinX, b.minX + ox);
            uMinY = Math.min(uMinY, b.minY + oy);
            uMaxX = Math.max(uMaxX, b.maxX + ox);
            uMaxY = Math.max(uMaxY, b.maxY + oy);
          }
          cachedVisibleBounds = {
            minX: uMinX,
            minY: uMinY,
            maxX: uMaxX,
            maxY: uMaxY,
          };
          boundsAreCanvasSpace = true;
        } else {
          multiOriginalOffsets = null;
          boundsAreCanvasSpace = false;
        }
      }
      moveDisplay.set(
        ctx.layer.offsetX,
        ctx.layer.offsetY,
        ctx.layer.layerWidth,
        ctx.layer.layerHeight,
      );
    },

    onPointerMove({ x, y }: ToolPointerPos, ctx: ToolContext) {
      if (!isDown) return;
      const dx = Math.round(x) - startX;
      const dy = Math.round(y) - startY;
      if (dx === lastDx && dy === lastDy) return;
      lastDx = dx;
      lastDy = dy;

      if (originalPixels) {
        applySelectionMove(dx, dy, ctx);
      } else if (textLayerSnapshot) {
        // Text layer: shift via GPU offset (same as pixel layers) to avoid
        // re-rasterizing on every frame. Final rasterize happens on pointer-up.
        ctx.renderer.setPreviewMode(true);
        ctx.layer.offsetX = dx;
        ctx.layer.offsetY = dy;
        ctx.render(ctx.layers);
      } else if (shapeLayerSnapshot) {
        // Shape layer: shift via GPU offset (same as pixel layers) to avoid
        // re-rasterizing on every frame. Final rasterize happens on pointer-up.
        ctx.renderer.setPreviewMode(true);
        ctx.layer.offsetX = dx;
        ctx.layer.offsetY = dy;
        ctx.render(ctx.layers);
      } else {
        // Update offset in-place (no pixel data change).
        // Enable preview mode so expensive standalone effects (bloom, halation, etc.)
        // are skipped during the drag — they rerun at full quality on pointer-up.
        ctx.renderer.setPreviewMode(true);
        const bounds = cachedVisibleBounds ?? {
          minX: 0,
          minY: 0,
          maxX: ctx.layer.layerWidth,
          maxY: ctx.layer.layerHeight,
        };
        const snapOrigX = boundsAreCanvasSpace ? 0 : originalOffsetX;
        const snapOrigY = boundsAreCanvasSpace ? 0 : originalOffsetY;
        const [sdx, sdy] = snapDelta(
          snapOrigX,
          snapOrigY,
          dx,
          dy,
          bounds,
          ctx.guides,
          ctx.zoom,
        );
        ctx.layer.offsetX = originalOffsetX + sdx;
        ctx.layer.offsetY = originalOffsetY + sdy;
        // Shift the linked mask layer in lock-step with the parent
        const maskGl = ctx.maskMap.get(ctx.layer.id);
        if (maskGl) applyMaskShift(sdx, sdy, maskGl, ctx.renderer);
        // Move all other selected layers by the same delta
        if (multiOriginalOffsets) {
          for (const [id, orig] of multiOriginalOffsets) {
            if (id === ctx.layer.id) continue;
            const gl = ctx.layers.find((l) => l.id === id);
            if (!gl) continue;
            gl.offsetX = orig.x + sdx;
            gl.offsetY = orig.y + sdy;
          }
        }
        ctx.render(ctx.layers);
      }
      moveDisplay.set(
        ctx.layer.offsetX,
        ctx.layer.offsetY,
        ctx.layer.layerWidth,
        ctx.layer.layerHeight,
      );
    },

    onPointerUp({ x, y }: ToolPointerPos, ctx: ToolContext) {
      if (!isDown) return;
      isDown = false;
      const dx = Math.round(x) - startX;
      const dy = Math.round(y) - startY;

      if (originalPixels) {
        if (dx !== lastDx || dy !== lastDy) applySelectionMove(dx, dy, ctx);
        if (originalMask && (dx !== 0 || dy !== 0))
          selectionStore.translateMask(dx, dy);
        originalPixels = null;
        originalMask = null;
      } else if (textLayerSnapshot) {
        // Reset offset before rasterizing so the text bakes its position into
        // pixel data at offset (0, 0), matching the normal text layer invariant.
        ctx.layer.offsetX = 0;
        ctx.layer.offsetY = 0;
        ctx.renderer.setPreviewMode(false);
        ctx.previewTextAt(
          textLayerSnapshot,
          textLayerOrigX + dx,
          textLayerOrigY + dy,
        );
        ctx.updateTextLayer({
          ...textLayerSnapshot,
          x: textLayerOrigX + dx,
          y: textLayerOrigY + dy,
        });
        textLayerSnapshot = null;
      } else if (shapeLayerSnapshot) {
        const moved = translateShapeLayer(shapeLayerSnapshot, dx, dy);
        // Reset offset before rasterizing so the shape bakes its position into
        // pixel data at offset (0, 0), matching the normal shape layer invariant.
        ctx.layer.offsetX = 0;
        ctx.layer.offsetY = 0;
        ctx.renderer.setPreviewMode(false);
        ctx.previewShapeLayer(moved);
        ctx.updateShapeLayer(moved);
        shapeLayerSnapshot = null;
      } else {
        const finalDx = dx !== lastDx || dy !== lastDy ? dx : lastDx;
        const finalDy = dx !== lastDx || dy !== lastDy ? dy : lastDy;
        const bounds = cachedVisibleBounds ?? {
          minX: 0,
          minY: 0,
          maxX: ctx.layer.layerWidth,
          maxY: ctx.layer.layerHeight,
        };
        const snapOrigX = boundsAreCanvasSpace ? 0 : originalOffsetX;
        const snapOrigY = boundsAreCanvasSpace ? 0 : originalOffsetY;
        const [sdx, sdy] = snapDelta(
          snapOrigX,
          snapOrigY,
          finalDx,
          finalDy,
          bounds,
          ctx.guides,
          ctx.zoom,
        );
        ctx.layer.offsetX = originalOffsetX + sdx;
        ctx.layer.offsetY = originalOffsetY + sdy;
        // Final mask shift (may differ from last pointermove if pointer jumped on up)
        const maskGl = ctx.maskMap.get(ctx.layer.id);
        if (maskGl) applyMaskShift(sdx, sdy, maskGl, ctx.renderer);
        // Commit final offsets for all other selected layers
        if (multiOriginalOffsets) {
          for (const [id, orig] of multiOriginalOffsets) {
            if (id === ctx.layer.id) continue;
            const gl = ctx.layers.find((l) => l.id === id);
            if (!gl) continue;
            gl.offsetX = orig.x + sdx;
            gl.offsetY = orig.y + sdy;
          }
        }
        multiOriginalOffsets = null;
        boundsAreCanvasSpace = false;
        originalMaskData = null;
        // Always exit preview mode and do a full-quality rerender on pointer-up
        // so standalone effects (bloom, halation, etc.) render at the final position.
        ctx.renderer.setPreviewMode(false);
        ctx.render(ctx.layers);
      }
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function MoveOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [pos, setPos] = useState({
    x: moveDisplay.x,
    y: moveDisplay.y,
    w: moveDisplay.w,
    h: moveDisplay.h,
  });
  const [snapToGuide, setSnapToGuide] = useState(moveOptions.snapToGuide);
  const [snapPoint, setSnapPoint] = useState<SnapPoint>(moveOptions.snapPoint);

  useEffect(() => {
    const sync = (): void =>
      setPos({
        x: moveDisplay.x,
        y: moveDisplay.y,
        w: moveDisplay.w,
        h: moveDisplay.h,
      });
    moveDisplay.subscribe(sync);
    return () => moveDisplay.unsubscribe(sync);
  }, []);

  const fmt = (v: number | null): string => (v !== null ? String(v) : "—");

  return (
    <>
      <label className={styles.optLabel}>X:</label>
      <span className={styles.optText}>{fmt(pos.x)}</span>
      <label className={styles.optLabel}>Y:</label>
      <span className={styles.optText}>{fmt(pos.y)}</span>
      <span className={styles.optSep} />
      <label className={styles.optLabel}>W:</label>
      <span className={styles.optText}>{fmt(pos.w)}</span>
      <label className={styles.optLabel}>H:</label>
      <span className={styles.optText}>{fmt(pos.h)}</span>
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={snapToGuide}
          onChange={(e) => {
            moveOptions.snapToGuide = e.target.checked;
            setSnapToGuide(e.target.checked);
          }}
        />
        Snap to Guide
      </label>
      {snapToGuide && (
        <select
          className={styles.optSelect}
          value={snapPoint}
          onChange={(e) => {
            const v = e.target.value as SnapPoint;
            moveOptions.snapPoint = v;
            setSnapPoint(v);
          }}
        >
          <option value="upper-left">Upper Left</option>
          <option value="upper-right">Upper Right</option>
          <option value="lower-left">Lower Left</option>
          <option value="lower-right">Lower Right</option>
          <option value="center">Center</option>
          <option value="vertical-middle">Vertical Middle</option>
          <option value="horizontal-middle">Horizontal Middle</option>
        </select>
      )}
    </>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const moveTool: ToolDefinition = {
  createHandler: createMoveHandler,
  Options: MoveOptions,
  modifiesPixels: true,
  worksOnAllLayers: true,
};
