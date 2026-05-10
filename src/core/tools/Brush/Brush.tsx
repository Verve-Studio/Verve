import React, { useEffect, useState } from "react";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import { useBrushes } from "@/core/services/useBrushes";
import { brushPanelStore } from "@/core/tools/Brush/brushPanelStore";
import { brushManagerStore } from "@/core/tools/Brush/brushManagerStore";
import type { Brush } from "@/types";
import { makeDefaultBrush } from "@/types";
import {
  makeStrokeStampState,
  stampSegment,
  stampDot,
  applyStrokeWetEdges,
  type StrokeStampState,
  type StrokePoseInputs,
} from "./stampEngine";
import { getCachedTipSampler } from "./tipSampler";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import brushIconSvg from "./brush.svg?raw";

// ─── Synchronous mirror of the active brush ──────────────────────────────────
//
// Pointer event handlers run synchronously and cannot read React state, so
// `activeBrushRef` is the single source of truth the stroke engine reads from.
// `BrushOptions` keeps it in sync via a useEffect on every brush change.

const activeBrushRef: { current: Brush } = {
  current: makeDefaultBrush("__bootstrap", "Default"),
};

export const brushOptions = {
  size: activeBrushRef.current.tip.size,
};

function syncFromActiveBrush(b: Brush): void {
  activeBrushRef.current = b;
  brushOptions.size = b.tip.size;
}

// ─── Constants ───────────────────────────────────────────────────────────────

function smoothingToAlpha(s: number): number {
  return Math.max(0.05, 1 - (s / 100) * 0.92);
}

const MAX_TRACKING_SPEED = 5;
const MIN_SIZE_FACTOR = 0.55;
const MIN_OPACITY_FACTOR = 0.65;
const SPEED_SMOOTHING = 0.25;
const MIN_PRESSURE_FACTOR = 0.05;
const PRESSURE_SMOOTHING = 0.15;

// ─── Handler ─────────────────────────────────────────────────────────────────

type Point = { x: number; y: number };

function createBrushHandler(): ToolHandler {
  // Smoothed input + position state
  let lastRendered: Point | null = null;
  let lastCtrl: Point | null = null;
  let renderedCursor: Point | null = null; // pull-string lagged cursor
  let strokeState: StrokeStampState | null = null;
  let smoothSpeed = 0;
  let stabX = 0,
    stabY = 0;
  let prevTime = 0;
  let smoothPressure = 1;
  let smoothTilt = 0;
  let smoothTiltAz = 0;
  let smoothTwist = 0;
  let prevSize = activeBrushRef.current.tip.size;
  let prevOpacity = activeBrushRef.current.opacity;
  let segDirtyMinX = Infinity,
    segDirtyMinY = Infinity,
    segDirtyMaxX = -Infinity,
    segDirtyMaxY = -Infinity;
  // Build-up / airbrush timer state
  let buildUpTimer: ReturnType<typeof setInterval> | null = null;
  let lastPaintCtx: ToolContext | null = null;
  let lastBuildUpPoint: Point | null = null;

  function resetSegDirty(): void {
    segDirtyMinX = Infinity;
    segDirtyMinY = Infinity;
    segDirtyMaxX = -Infinity;
    segDirtyMaxY = -Infinity;
  }

  /** Snapshot the pen pose for the current sample. */
  function makePose(): StrokePoseInputs {
    const tiltMag = Math.min(1, smoothTilt);
    return {
      pressure: smoothPressure,
      velocity: Math.min(1, smoothSpeed / MAX_TRACKING_SPEED),
      tilt: tiltMag,
      tiltAzimuth: smoothTiltAz,
      rotation: smoothTwist,
      // Filled in per-segment by the engine.
      direction: 0,
    };
  }

  /** Paint one Bézier segment (or a degenerate point) using the stamp engine. */
  function paint(
    p0x: number,
    p0y: number,
    cpx: number,
    cpy: number,
    p1x: number,
    p1y: number,
    size0: number,
    opacity0: number,
    size1: number,
    opacity1: number,
    ctx: ToolContext,
  ): void {
    if (!strokeState) return;
    const brush = activeBrushRef.current;
    const sampler = getCachedTipSampler(brush.shape);

    const {
      renderer,
      layer,
      layers,
      primaryColor,
      secondaryColor,
      selectionMask,
      render,
      growLayerToFit,
    } = ctx;
    // Worst-case stamp bbox extension. Soft brushes (hardness=0) add up to
    // 0.5 × radius of feathering, and motion blur stretches the stamp along
    // stroke direction by up to 4× at motionBlur=100. Combined upper bound:
    //   half ≈ radius × elongMax + radius × 0.5  (= 0.5 size × (elongMax + 0.5))
    const elongMax = 1 + 3 * Math.max(0, Math.min(100, brush.motionBlur)) / 100;
    const maxSize = Math.max(size0, size1);
    const padR = Math.ceil(maxSize * (0.5 * elongMax + 0.25) + 3);
    if (!ctx.tiledMode) {
      const minX = Math.min(p0x, cpx, p1x) - padR;
      const minY = Math.min(p0y, cpy, p1y) - padR;
      const maxX = Math.max(p0x, cpx, p1x) + padR;
      const maxY = Math.max(p0y, cpy, p1y) + padR;
      if (
        maxX < 0 ||
        maxY < 0 ||
        minX >= renderer.pixelWidth ||
        minY >= renderer.pixelHeight
      )
        return;
    }
    growLayerToFit(Math.round(p0x), Math.round(p0y), padR);
    growLayerToFit(Math.round(cpx), Math.round(cpy), padR);
    growLayerToFit(Math.round(p1x), Math.round(p1y), padR);

    resetSegDirty();
    const collect = (
      sx0: number,
      sy0: number,
      sx1: number,
      sy1: number,
    ): void => {
      if (sx0 < segDirtyMinX) segDirtyMinX = sx0;
      if (sy0 < segDirtyMinY) segDirtyMinY = sy0;
      if (sx1 > segDirtyMaxX) segDirtyMaxX = sx1;
      if (sy1 > segDirtyMaxY) segDirtyMaxY = sy1;
    };

    const pose = makePose();
    const isDot =
      p0x === p1x && p0y === p1y && p0x === cpx && p0y === cpy;
    if (isDot) {
      stampDot(
        renderer,
        layer,
        layers,
        brush,
        sampler,
        p0x,
        p0y,
        size0,
        opacity0,
        primaryColor,
        secondaryColor,
        selectionMask,
        ctx.tiledMode,
        strokeState,
        pose,
        collect,
      );
    } else {
      stampSegment({
        renderer,
        layer,
        layers,
        brush,
        sampler,
        p0x,
        p0y,
        cpx,
        cpy,
        p1x,
        p1y,
        size0,
        size1,
        opacity0,
        opacity1,
        primary: primaryColor,
        secondary: secondaryColor,
        selectionMask,
        tiledMode: ctx.tiledMode,
        state: strokeState,
        pose,
        onStampBbox: collect,
        forceFirst: strokeState.isFirstStamp,
      });
    }

    if (!ctx.tiledMode && segDirtyMaxX >= segDirtyMinX) {
      const lx = Math.max(0, Math.floor(segDirtyMinX - layer.offsetX));
      const ly = Math.max(0, Math.floor(segDirtyMinY - layer.offsetY));
      const rx = Math.min(
        layer.layerWidth,
        Math.ceil(segDirtyMaxX - layer.offsetX) + 1,
      );
      const ry = Math.min(
        layer.layerHeight,
        Math.ceil(segDirtyMaxY - layer.offsetY) + 1,
      );
      renderer.markDirtyRect(layer, lx, ly, rx, ry);
    }

    renderer.flushLayer(layer);
    render(layers);
  }

  function resolveStrokeParams(
    speed: number,
    pressure: number,
  ): { size: number; opacity: number } {
    const brush = activeBrushRef.current;
    let size = brush.tip.size;
    let opacity = brush.opacity;

    if (brush.velocityTracking && speed > 0) {
      const t = Math.min(1, speed / MAX_TRACKING_SPEED);
      size = size * Math.max(MIN_SIZE_FACTOR, 1 - t * (1 - MIN_SIZE_FACTOR));
      opacity =
        opacity *
        Math.max(MIN_OPACITY_FACTOR, 1 - t * (1 - MIN_OPACITY_FACTOR));
    }

    if (brush.pressureSize) {
      size = size * Math.max(MIN_PRESSURE_FACTOR, pressure);
    }

    return { size, opacity };
  }

  /** Pull-string smoothing — moves `renderedCursor` toward `target` while
   *  keeping at most `pullDist` distance behind it. Returns the new rendered
   *  position so the caller can use it as the input to the curve construction. */
  function applyPullString(
    targetX: number,
    targetY: number,
    pullDist: number,
  ): { x: number; y: number } {
    if (!renderedCursor || pullDist <= 0) {
      renderedCursor = { x: targetX, y: targetY };
      return renderedCursor;
    }
    const dx = targetX - renderedCursor.x;
    const dy = targetY - renderedCursor.y;
    const d = Math.hypot(dx, dy);
    if (d > pullDist) {
      const k = (d - pullDist) / d;
      renderedCursor = {
        x: renderedCursor.x + dx * k,
        y: renderedCursor.y + dy * k,
      };
    }
    return renderedCursor;
  }

  /** Stop the build-up timer if running. */
  function stopBuildUp(): void {
    if (buildUpTimer !== null) {
      clearInterval(buildUpTimer);
      buildUpTimer = null;
    }
  }

  /** Restart the build-up timer with the current brush rate. Each tick clears
   *  the touched map (so coverage genuinely accumulates) and stamps once at
   *  the held position. Photoshop calls this "airbrush" behaviour. */
  function startBuildUp(ctx: ToolContext, x: number, y: number): void {
    const brush = activeBrushRef.current;
    if (!brush.buildUp.enabled) return;
    stopBuildUp();
    lastPaintCtx = ctx;
    lastBuildUpPoint = { x, y };
    const intervalMs = Math.max(8, 1000 / Math.max(1, brush.buildUp.rate));
    buildUpTimer = setInterval(() => {
      if (!strokeState || !lastPaintCtx || !lastBuildUpPoint) return;
      // Each tick is a fresh dose of paint — clear touched so coverage
      // can climb past previous strokes within this tick.
      strokeState.touched = new Map();
      const { size, opacity } = resolveStrokeParams(0, smoothPressure);
      const px = lastBuildUpPoint.x;
      const py = lastBuildUpPoint.y;
      paint(px, py, px, py, px, py, size, opacity, size, opacity, lastPaintCtx);
    }, intervalMs);
  }

  return {
    onPointerDown(
      { x, y, pressure, tiltX, tiltY, twist, timeStamp }: ToolPointerPos,
      ctx: ToolContext,
    ) {
      ctx.renderer.strokeStart();
      strokeState = makeStrokeStampState(ctx.primaryColor);
      smoothSpeed = 0;
      smoothPressure = pressure;
      smoothTilt = Math.hypot(tiltX, tiltY) / 90;
      smoothTiltAz = Math.atan2(tiltY, tiltX);
      smoothTwist = (twist * Math.PI) / 180;
      stabX = x;
      stabY = y;
      prevTime = timeStamp;
      lastRendered = { x, y };
      lastCtrl = { x, y };
      renderedCursor = { x, y };
      const { size, opacity } = resolveStrokeParams(0, smoothPressure);
      prevSize = size;
      prevOpacity = opacity;
      paint(x, y, x, y, x, y, size, opacity, size, opacity, ctx);
      startBuildUp(ctx, x, y);
    },

    onPointerMove(
      { x, y, pressure, tiltX, tiltY, twist, timeStamp }: ToolPointerPos,
      ctx: ToolContext,
    ) {
      if (!lastRendered || !lastCtrl) return;
      const brush = activeBrushRef.current;
      const now = timeStamp;
      const alpha = smoothingToAlpha(brush.smoothing.ema);
      stabX = stabX * (1 - alpha) + x * alpha;
      stabY = stabY * (1 - alpha) + y * alpha;

      // Pull-string lag — renderedCursor follows stabX/stabY at a fixed distance.
      const pullDist = brush.smoothing.pullString * brush.tip.size;
      const drawn = applyPullString(stabX, stabY, pullDist);
      const drawX = drawn.x;
      const drawY = drawn.y;

      const dt = now - prevTime;
      const d = Math.hypot(drawX - lastCtrl.x, drawY - lastCtrl.y);
      smoothSpeed =
        smoothSpeed * (1 - SPEED_SMOOTHING) +
        (dt > 0 ? d / dt : 0) * SPEED_SMOOTHING;
      smoothPressure =
        smoothPressure * (1 - PRESSURE_SMOOTHING) +
        pressure * PRESSURE_SMOOTHING;
      smoothTilt =
        smoothTilt * (1 - PRESSURE_SMOOTHING) +
        (Math.hypot(tiltX, tiltY) / 90) * PRESSURE_SMOOTHING;
      const az = Math.atan2(tiltY, tiltX);
      smoothTiltAz =
        smoothTiltAz * (1 - PRESSURE_SMOOTHING) + az * PRESSURE_SMOOTHING;
      smoothTwist = (twist * Math.PI) / 180;
      prevTime = now;

      const { size, opacity } = resolveStrokeParams(
        smoothSpeed,
        smoothPressure,
      );
      const segStep = Math.max(
        1,
        Math.min(prevSize, size) * (brush.tip.spacing / 100) * 0.5,
      );
      const tipX = (lastCtrl.x + drawX) * 0.5;
      const tipY = (lastCtrl.y + drawY) * 0.5;
      if (Math.hypot(tipX - lastRendered.x, tipY - lastRendered.y) >= segStep) {
        paint(
          lastRendered.x,
          lastRendered.y,
          lastCtrl.x,
          lastCtrl.y,
          tipX,
          tipY,
          prevSize,
          prevOpacity,
          size,
          opacity,
          ctx,
        );
        lastRendered = { x: tipX, y: tipY };
        prevSize = size;
        prevOpacity = opacity;
      }
      lastCtrl = { x: drawX, y: drawY };
      // Build-up tracks the latest pointer position so airbrush ticks paint
      // wherever the pen happens to be hovering when held still.
      if (buildUpTimer !== null) {
        lastPaintCtx = ctx;
        lastBuildUpPoint = { x: drawX, y: drawY };
      }
    },

    onPointerUp(_pos: ToolPointerPos, ctx: ToolContext) {
      stopBuildUp();
      const brush = activeBrushRef.current;
      if (lastRendered && lastCtrl) {
        const { size, opacity } = resolveStrokeParams(
          smoothSpeed,
          smoothPressure,
        );
        const dist = Math.hypot(
          lastCtrl.x - lastRendered.x,
          lastCtrl.y - lastRendered.y,
        );
        if (dist >= 1) {
          paint(
            lastRendered.x,
            lastRendered.y,
            lastCtrl.x,
            lastCtrl.y,
            lastCtrl.x,
            lastCtrl.y,
            prevSize,
            prevOpacity,
            size,
            opacity,
            ctx,
          );
        }
        // Catch-up: if pull-string left us behind the actual pointer, draw the
        // remaining gap so the stroke ends at the user's intended position.
        if (
          brush.smoothing.catchUp &&
          renderedCursor &&
          (Math.abs(stabX - renderedCursor.x) > 0.5 ||
            Math.abs(stabY - renderedCursor.y) > 0.5)
        ) {
          paint(
            renderedCursor.x,
            renderedCursor.y,
            stabX,
            stabY,
            stabX,
            stabY,
            prevSize,
            prevOpacity,
            size,
            opacity,
            ctx,
          );
        }
      }
      // Stroke-level wet edges: a single rim around the entire painted
      // silhouette, computed from the per-stroke `touched` map. Per-stamp
      // wet edges produced concentric halos at every dab; this is the
      // watercolor pooling effect users actually expect.
      if (strokeState && brush.wetEdges.enabled) {
        const wet = applyStrokeWetEdges(
          ctx.renderer,
          ctx.layer,
          strokeState.touched,
          brush,
        );
        if (wet.dirty) {
          ctx.renderer.markDirtyRect(
            ctx.layer,
            wet.dirty.lx,
            wet.dirty.ly,
            wet.dirty.rx,
            wet.dirty.ry,
          );
          ctx.renderer.flushLayer(ctx.layer);
          ctx.render(ctx.layers);
        }
      }
      lastRendered = null;
      lastCtrl = null;
      renderedCursor = null;
      strokeState = null;
      lastPaintCtx = null;
      lastBuildUpPoint = null;
      smoothSpeed = 0;
      prevSize = activeBrushRef.current.tip.size;
      prevOpacity = activeBrushRef.current.opacity;
      ctx.renderer.strokeEnd();
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function BrushOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const { activeBrush, allBrushes, selectBrush, updateBrush, createBrush } =
    useBrushes();
  useEffect(() => {
    syncFromActiveBrush(activeBrush);
  }, [activeBrush]);

  const [size, setSize] = useState(activeBrush.tip.size);
  const [opacity, setOpacity] = useState(activeBrush.opacity);
  const [hardness, setHardness] = useState(activeBrush.tip.hardness);
  useEffect(() => {
    setSize(activeBrush.tip.size);
    setOpacity(activeBrush.opacity);
    setHardness(activeBrush.tip.hardness);
  }, [activeBrush.id]);

  const handleSize = (v: number): void => {
    setSize(v);
    void updateBrush({
      ...activeBrush,
      tip: { ...activeBrush.tip, size: v },
    });
  };
  const handleOpacity = (v: number): void => {
    setOpacity(v);
    void updateBrush({ ...activeBrush, opacity: v });
  };
  const handleHardness = (v: number): void => {
    setHardness(v);
    void updateBrush({
      ...activeBrush,
      tip: { ...activeBrush.tip, hardness: v },
    });
  };

  return (
    <>
      <label className={styles.optLabel}>Brush:</label>
      <select
        className={styles.optSelect}
        value={activeBrush.id}
        onChange={(e) => {
          if (e.target.value === "__new__") {
            void createBrush({}, "user");
          } else {
            selectBrush(e.target.value);
          }
        }}
      >
        {allBrushes.length === 0 && (
          <option value={activeBrush.id}>{activeBrush.name}</option>
        )}
        {allBrushes.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name} ({b.scope[0].toUpperCase()})
          </option>
        ))}
        <option value="__new__">+ New brush</option>
      </select>
      <span className={styles.optSep} />
      <button
        type="button"
        className={styles.optBtn}
        onClick={() => brushPanelStore.toggle()}
        title="Open brush settings panel"
      >
        Settings…
      </button>
      <span className={styles.optSep} />
      <button
        type="button"
        className={styles.optBtn}
        onClick={() => brushManagerStore.open()}
        title="Open the Paint Brushes manager (rename, organise, import/export)"
      >
        Manage…
      </button>
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Size:</label>
      <SliderInput
        value={size}
        min={1}
        max={500}
        inputWidth={42}
        onChange={handleSize}
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
      <label className={styles.optLabel}>Hardness:</label>
      <SliderInput
        value={hardness}
        min={0}
        max={100}
        suffix="%"
        inputWidth={42}
        onChange={handleHardness}
      />
    </>
  );
}

class BrushTool implements ITool {
  readonly id = "brush";
  readonly label = "Brush";
  readonly shortcut = "B";
  readonly icon = <SvgIcon src={brushIconSvg} />;
  readonly placement = {
    group: ToolGroup.Painting,
    row: 0,
    column: 0,
  } as const;
  readonly modifiesPixels = true;
  readonly paintsOntoPixelLayer = true;
  readonly pixelOnly = true;
  readonly indexed8Unsupported = true;
  createHandler(): ToolHandler {
    return createBrushHandler();
  }
  readonly Options = BrushOptions;
}

export const brushTool: ITool = new BrushTool();
