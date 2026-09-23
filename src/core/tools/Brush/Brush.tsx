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
import type { WebGPURenderer, GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
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

/** Split the canvas-space span [a, b) into pieces wrapped into [0, n). */
function wrapSpans(a: number, b: number, n: number): Array<[number, number]> {
  if (b - a >= n) return [[0, n]];
  const a0 = ((a % n) + n) % n;
  const len = b - a;
  if (a0 + len <= n) return [[a0, a0 + len]];
  return [
    [a0, n],
    [0, a0 + len - n],
  ];
}

/** Mark a canvas-space rect dirty on a tiled (wrapping) canvas. */
function markWrappedDirty(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const W = renderer.pixelWidth;
  const H = renderer.pixelHeight;
  for (const [ax, bx] of wrapSpans(x0, x1, W)) {
    for (const [ay, by] of wrapSpans(y0, y1, H)) {
      const lx = Math.max(0, ax - layer.offsetX);
      const ly = Math.max(0, ay - layer.offsetY);
      const rx = Math.min(layer.layerWidth, bx - layer.offsetX);
      const ry = Math.min(layer.layerHeight, by - layer.offsetY);
      if (rx > lx && ry > ly) renderer.markDirtyRect(layer, lx, ly, rx, ry);
    }
  }
}

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
  // Previous pose snapshot — paired with prevSize/prevOpacity so segments
  // can lerp pose-driven dynamics (size/color/scatter jitter that read
  // velocity/pressure/tilt) smoothly across pointer-event boundaries
  // instead of stepping at each event. Reset on stroke start.
  let prevPose: StrokePoseInputs | null = null;
  let segDirtyMinX = Infinity,
    segDirtyMinY = Infinity,
    segDirtyMaxX = -Infinity,
    segDirtyMaxY = -Infinity;
  // Build-up / airbrush timer state
  let buildUpTimer: ReturnType<typeof setInterval> | null = null;
  let lastPaintCtx: ToolContext | null = null;
  let lastBuildUpPoint: Point | null = null;
  // ── rAF-coalesced flushLayer + render ──────────────────────────────────
  // High-poll-rate tablets fire 120+ pointer events/sec. Each event
  // previously paid the full GPU sync (texture upload + composite + present)
  // even though the screen only refreshes at 60–120 Hz. We accumulate the
  // CPU-side dirty rect across events (markDirtyRect unions multiple
  // calls) and defer the actual upload+present to a single requestAnimationFrame.
  // Pixel writes still happen synchronously inside paint(); only the GPU
  // commit is deferred. The drainPendingFlush() helper makes pointer-up /
  // wet-edges run their final commit synchronously so the stroke ends with
  // a fully-presented frame.
  let pendingFlushRAF: number | null = null;
  let pendingFlushRenderer: WebGPURenderer | null = null;
  let pendingFlushLayer: GpuLayer | null = null;
  let pendingFlushLayers: GpuLayer[] | null = null;
  let pendingFlushRender: ((layers?: GpuLayer[]) => void) | null = null;

  function commitPendingFlush(): void {
    if (
      !pendingFlushRenderer ||
      !pendingFlushLayer ||
      !pendingFlushLayers ||
      !pendingFlushRender
    ) {
      return;
    }
    // With a pen, the coalesced-batch path in useCanvasPointerInput has
    // usually uploaded this frame's dirty patch already. Flushing again with
    // nothing pending would fall back to a FULL-layer upload (~133 MB on a
    // 4K rgba32f layer) plus a full re-composite, every frame.
    if (pendingFlushRenderer.hasPendingUpload(pendingFlushLayer)) {
      pendingFlushRenderer.flushLayer(pendingFlushLayer);
    }
    pendingFlushRender(pendingFlushLayers);
    pendingFlushRenderer = null;
    pendingFlushLayer = null;
    pendingFlushLayers = null;
    pendingFlushRender = null;
  }

  function scheduleFlushAndRender(
    renderer: WebGPURenderer,
    layer: GpuLayer,
    layers: GpuLayer[],
    render: (layers?: GpuLayer[]) => void,
  ): void {
    // Always update to the latest references so the deferred commit uses
    // the freshest layer state.
    pendingFlushRenderer = renderer;
    pendingFlushLayer = layer;
    pendingFlushLayers = layers;
    pendingFlushRender = render;
    if (pendingFlushRAF !== null) return;
    pendingFlushRAF = requestAnimationFrame(() => {
      pendingFlushRAF = null;
      commitPendingFlush();
    });
  }

  function drainPendingFlush(): void {
    if (pendingFlushRAF !== null) {
      cancelAnimationFrame(pendingFlushRAF);
      pendingFlushRAF = null;
    }
    commitPendingFlush();
  }

  function resetSegDirty(): void {
    segDirtyMinX = Infinity;
    segDirtyMinY = Infinity;
    segDirtyMaxX = -Infinity;
    segDirtyMaxY = -Infinity;
  }

  /**
   * Default pressure response curve — a gentle smoothstep S-curve that
   * gives Wacom/Apple Pencil hardware a more "paintable" feel than the
   * raw linear input. Hardware pressure is too touchy at the low end and
   * too easy to peg at the top; the cubic Hermite below softens both
   * extremes while keeping the midrange responsive. Applied centrally in
   * `makePose` so every consumer of `pose.pressure` (dynamic curves +
   * `pressureSize`) sees the same shaped value. The user's per-curve
   * Catmull–Rom editor still applies on top, so brushes that want a
   * different response just edit their curve.
   */
  function shapePressure(p: number): number {
    const x = Math.max(0, Math.min(1, p));
    return x * x * (3 - 2 * x);
  }

  /** Snapshot the pen pose for the current sample. */
  function makePose(): StrokePoseInputs {
    const tiltMag = Math.min(1, smoothTilt);
    return {
      pressure: shapePressure(smoothPressure),
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
    pose0: StrokePoseInputs,
    pose1: StrokePoseInputs,
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
    // Worst-case stamp reach from the path, in radii (r = size / 2):
    //   √2        square / bitmap tip corners at any angle
    //   + shear   tilt shear stretches the tip by up to tiltScale × r
    //   + elong−1 motion blur (up to 4× at motionBlur = 100)
    //   + 0.5     soft-edge feathering
    //   + scatter stamps are offset by amount × r (× jitter; 1.5 for margin)
    // Stamps beyond the grown layer were silently dropped at its edge.
    const elongMax = 1 + 3 * Math.max(0, Math.min(100, brush.motionBlur)) / 100;
    const maxSize = Math.max(size0, size1);
    const reachRadii =
      Math.SQRT2 +
      Math.max(0, brush.pose.tiltScale) +
      (elongMax - 1) +
      0.5 +
      1.5 * Math.max(0, brush.scatter.amount);
    const padR = Math.ceil(maxSize * 0.5 * reachRadii + 3);
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
        pose1,
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
        pose0,
        pose1,
        onStampBbox: collect,
        forceFirst: strokeState.isFirstStamp,
      });
    }

    if (ctx.tiledMode && segDirtyMaxX >= segDirtyMinX) {
      // Tiled mode wraps stamps around the canvas edges: mark the segment's
      // bbox split into its (up to 4) wrapped pieces. Without any dirty
      // rect the flush was skipped and mouse strokes never reached the GPU.
      markWrappedDirty(
        renderer,
        layer,
        Math.floor(segDirtyMinX),
        Math.floor(segDirtyMinY),
        Math.ceil(segDirtyMaxX) + 1,
        Math.ceil(segDirtyMaxY) + 1,
      );
    } else if (!ctx.tiledMode && segDirtyMaxX >= segDirtyMinX) {
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

    scheduleFlushAndRender(renderer, layer, layers, render);
  }

  function resolveStrokeParams(
    pressure: number,
  ): { size: number; opacity: number } {
    const brush = activeBrushRef.current;
    let size = brush.tip.size;
    const opacity = brush.opacity;

    if (brush.pressureSize) {
      size = size * Math.max(MIN_PRESSURE_FACTOR, shapePressure(pressure));
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
  // Build-up clears `touched` every tick so coverage can climb; the wet-edge
  // pass at stroke end needs the WHOLE stroke's silhouette, so (only when
  // wet edges are on) each tick first max-merges its coverage into this
  // stroke-lifetime buffer, and the lifetime bbox is tracked separately.
  let wetSilhouette: Uint8Array | null = null;
  let lifeBbox: { lx: number; ly: number; rx: number; ry: number } | null =
    null;

  function unionLifeBbox(st: NonNullable<typeof strokeState>): void {
    if (!st.strokeBboxValid) return;
    if (!lifeBbox) {
      lifeBbox = {
        lx: st.strokeBboxLx,
        ly: st.strokeBboxLy,
        rx: st.strokeBboxRx,
        ry: st.strokeBboxRy,
      };
      return;
    }
    lifeBbox.lx = Math.min(lifeBbox.lx, st.strokeBboxLx);
    lifeBbox.ly = Math.min(lifeBbox.ly, st.strokeBboxLy);
    lifeBbox.rx = Math.max(lifeBbox.rx, st.strokeBboxRx);
    lifeBbox.ry = Math.max(lifeBbox.ry, st.strokeBboxRy);
  }

  /** Max-merge the current tick's coverage into the silhouette. */
  function mergeSilhouette(
    st: NonNullable<typeof strokeState>,
    fullBuffer: boolean,
  ): void {
    const t = st.touched;
    if (!wetSilhouette || wetSilhouette.length !== t.data.length) {
      wetSilhouette = new Uint8Array(t.data.length);
    }
    const sil = wetSilhouette;
    const src = t.data;
    if (fullBuffer || !st.strokeBboxValid) {
      for (let i = 0; i < src.length; i++) if (src[i] > sil[i]) sil[i] = src[i];
      return;
    }
    const lx = Math.max(0, Math.floor(st.strokeBboxLx));
    const ly = Math.max(0, Math.floor(st.strokeBboxLy));
    const rx = Math.min(t.width, Math.ceil(st.strokeBboxRx) + 1);
    const ry = Math.min(t.height, Math.ceil(st.strokeBboxRy) + 1);
    for (let y = ly; y < ry; y++) {
      const row = y * t.width;
      for (let i = row + lx; i < row + rx; i++) {
        if (src[i] > sil[i]) sil[i] = src[i];
      }
    }
  }

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
      // can climb past previous strokes within this tick. Only the region
      // painted so far can be non-zero, so clear just that (same bbox the
      // end-of-stroke cleanup uses) instead of the whole canvas-sized
      // buffer, which cost ~16–70 MB of memset per tick (every ≥8 ms).
      const touched = strokeState.touched;
      if (activeBrushRef.current.wetEdges.enabled) {
        if (!wetSilhouette || wetSilhouette.length !== touched.data.length) {
          wetSilhouette = new Uint8Array(touched.data.length);
        } else if (!lifeBbox) {
          wetSilhouette.fill(0);
        }
        mergeSilhouette(strokeState, lastPaintCtx.tiledMode);
        unionLifeBbox(strokeState);
      }
      // Tiled strokes write coverage at wrapped coordinates that the
      // (unwrapped) stroke bbox doesn't describe: clear everything.
      if (strokeState.strokeBboxValid && !lastPaintCtx.tiledMode) {
        const lx = Math.max(0, Math.floor(strokeState.strokeBboxLx));
        const ly = Math.max(0, Math.floor(strokeState.strokeBboxLy));
        const rx = Math.min(touched.width, Math.ceil(strokeState.strokeBboxRx) + 1);
        const ry = Math.min(touched.height, Math.ceil(strokeState.strokeBboxRy) + 1);
        for (let y = ly; y < ry; y++) {
          touched.data.fill(0, y * touched.width + lx, y * touched.width + rx);
        }
      } else {
        touched.data.fill(0);
      }
      strokeState.strokeBboxValid = false;
      const { size, opacity } = resolveStrokeParams(smoothPressure);
      const px = lastBuildUpPoint.x;
      const py = lastBuildUpPoint.y;
      const tickPose = makePose();
      paint(px, py, px, py, px, py, size, opacity, size, opacity, tickPose, tickPose, lastPaintCtx);
    }, intervalMs);
  }

  return {
    onPointerDown(
      { x, y, pressure, tiltX, tiltY, twist, timeStamp }: ToolPointerPos,
      ctx: ToolContext,
    ) {
      ctx.renderer.strokeStart();
      // Renderer owns the per-stroke max-coverage buffer (single shared
      // Uint8Array, reused across strokes via memcpy-zero at this call).
      strokeState = makeStrokeStampState(
        ctx.primaryColor,
        ctx.renderer.acquireTouchedBuffer(),
      );
      // The WASM stamp kernel writes coverage without recording a write box;
      // the stroke end sets lastDirtyRect instead (or, if it can't, the next
      // acquire falls back to a full clear).
      strokeState.touched.untracked = true;
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
      const { size, opacity } = resolveStrokeParams(smoothPressure);
      prevSize = size;
      prevOpacity = opacity;
      const downPose = makePose();
      prevPose = downPose;
      paint(x, y, x, y, x, y, size, opacity, size, opacity, downPose, downPose, ctx);
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
      // Interpolate along the shortest arc: a linear EMA from 179° to -179°
      // swept through 0° and briefly reversed the tilt shear.
      {
        let d = az - smoothTiltAz;
        d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
        smoothTiltAz += d * PRESSURE_SMOOTHING;
        smoothTiltAz -= Math.round(smoothTiltAz / (2 * Math.PI)) * 2 * Math.PI;
      }
      smoothTwist = (twist * Math.PI) / 180;
      prevTime = now;

      const { size, opacity } = resolveStrokeParams(smoothPressure);
      const segStep = Math.max(
        1,
        Math.min(prevSize, size) * (brush.tip.spacing / 100) * 0.5,
      );
      const tipX = (lastCtrl.x + drawX) * 0.5;
      const tipY = (lastCtrl.y + drawY) * 0.5;
      if (Math.hypot(tipX - lastRendered.x, tipY - lastRendered.y) >= segStep) {
        const movePose = makePose();
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
          prevPose ?? movePose,
          movePose,
          ctx,
        );
        lastRendered = { x: tipX, y: tipY };
        prevSize = size;
        prevOpacity = opacity;
        prevPose = movePose;
      }
      lastCtrl = { x: drawX, y: drawY };
      // Build-up tracks the latest pointer position so airbrush ticks paint
      // wherever the pen happens to be hovering when held still.
      if (buildUpTimer !== null) {
        lastPaintCtx = ctx;
        lastBuildUpPoint = { x: drawX, y: drawY };
      }
    },

    onCancel(): void {
      // Stroke abandoned (layer gone / tool threw): stop the build-up timer
      // and drop per-stroke state without touching pixels.
      stopBuildUp();
      // Drop (don't commit) the pending flush: its layer may be gone.
      if (pendingFlushRAF !== null) {
        cancelAnimationFrame(pendingFlushRAF);
        pendingFlushRAF = null;
      }
      pendingFlushRenderer = null;
      pendingFlushLayer = null;
      pendingFlushLayers = null;
      pendingFlushRender = null;
      lastRendered = null;
      lastCtrl = null;
      renderedCursor = null;
      strokeState = null;
      lastPaintCtx = null;
      lastBuildUpPoint = null;
      lifeBbox = null;
      prevPose = null;
    },

    onPointerUp(_pos: ToolPointerPos, ctx: ToolContext) {
      stopBuildUp();
      const brush = activeBrushRef.current;
      if (lastRendered && lastCtrl) {
        const { size, opacity } = resolveStrokeParams(smoothPressure);
        const dist = Math.hypot(
          lastCtrl.x - lastRendered.x,
          lastCtrl.y - lastRendered.y,
        );
        const upPose = makePose();
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
            prevPose ?? upPose,
            upPose,
            ctx,
          );
          prevPose = upPose;
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
            prevPose ?? upPose,
            upPose,
            ctx,
          );
        }
      }
      // Stroke-level wet edges: a single rim around the entire painted
      // silhouette, computed from the per-stroke `touched` map. Per-stamp
      // wet edges produced concentric halos at every dab; this is the
      // watercolor pooling effect users actually expect.
      // With build-up, merge the final tick and use the lifetime silhouette.
      let wetTouched = strokeState ? strokeState.touched : null;
      if (strokeState && brush.wetEdges.enabled && lifeBbox && wetSilhouette) {
        mergeSilhouette(strokeState, ctx.tiledMode);
        unionLifeBbox(strokeState);
        wetTouched = {
          ...strokeState.touched,
          data: wetSilhouette,
          wasmPtr: undefined,
          lastDirtyRect: undefined,
        };
      }
      if (strokeState && wetTouched && brush.wetEdges.enabled) {
        const wet = applyStrokeWetEdges(
          ctx.renderer,
          ctx.layer,
          wetTouched,
          brush,
          ctx.tiledMode
            ? // Wrapped coverage lies outside the unwrapped bbox.
              {
                lx: 0,
                ly: 0,
                rx: ctx.renderer.pixelWidth - 1,
                ry: ctx.renderer.pixelHeight - 1,
              }
            : lifeBbox
              ? { ...lifeBbox }
              : strokeState.strokeBboxValid
                ? {
                    lx: strokeState.strokeBboxLx,
                    ly: strokeState.strokeBboxLy,
                    rx: strokeState.strokeBboxRx,
                    ry: strokeState.strokeBboxRy,
                  }
                : null,
        );
        if (wet.dirty) {
          ctx.renderer.markDirtyRect(
            ctx.layer,
            wet.dirty.lx,
            wet.dirty.ly,
            wet.dirty.rx,
            wet.dirty.ry,
          );
          // Don't fire the GPU sync inline — let `drainPendingFlush()`
          // below commit segments + wet-edges in one go.
          scheduleFlushAndRender(
            ctx.renderer,
            ctx.layer,
            ctx.layers,
            ctx.render,
          );
        }
      }
      // Force the final commit synchronously so the stroke ends with a
      // fully-presented frame. Any unflushed segment work from a still-
      // pending rAF is unioned into the same flushLayer call (the dirty
      // rect on the layer accumulates across markDirtyRect calls).
      drainPendingFlush();
      // Tell the touched buffer which region we wrote to, so the next
      // `acquireTouchedBuffer` can clear *just* that region instead of
      // memset-ing the whole canvas-sized buffer (saves ~2 ms per stroke
      // start on A1, way more on bigger docs).
      // Not for tiled strokes: their coverage is written at wrapped
      // coordinates outside this bbox, so the next stroke must fully clear.
      if (strokeState && strokeState.strokeBboxValid && !ctx.tiledMode) {
        strokeState.touched.lastDirtyRect = {
          lx: strokeState.strokeBboxLx,
          ly: strokeState.strokeBboxLy,
          rx: strokeState.strokeBboxRx + 1,
          ry: strokeState.strokeBboxRy + 1,
        };
      }
      lastRendered = null;
      lastCtrl = null;
      renderedCursor = null;
      strokeState = null;
      lastPaintCtx = null;
      lastBuildUpPoint = null;
      lifeBbox = null;
      smoothSpeed = 0;
      prevSize = activeBrushRef.current.tip.size;
      prevOpacity = activeBrushRef.current.opacity;
      prevPose = null;
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
