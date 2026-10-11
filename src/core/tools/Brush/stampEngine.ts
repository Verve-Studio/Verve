/**
 * Photoshop-style stamp-along-spline brush engine.
 *
 * The painter splits the input pointer trail into quadratic Bézier segments
 * (built upstream by the existing midpoint B-spline stabiliser in
 * `brush.tsx`) and feeds each one to `stampSegment`. The engine walks the
 * segment by ~equal arc-length steps of `spacing × radius` and applies one
 * stamp per step (or `count` stamps if scatter count > 1). Each stamp
 * evaluates the tip's coverage (`tipSampler.ts`: a hardness-sized opaque
 * core fading out inside the radius with a 1 px anti-aliased edge, or a
 * sampled tip's density map) over its bounding box and composites it into
 * the layer — in the WASM kernel (`wasm/src/brush_stamp.cpp`) when it can,
 * otherwise via `blendPixelOver`, which handles all three pixel formats,
 * the selection mask, tiled-mode wrapping, the per-stroke `touched`
 * coverage map and HDR srcFloat.
 *
 * Painting model: positions are sub-pixel (pixel centres at integer
 * coordinates). Opacity is a per-stroke ceiling and Flow the share of it
 * each stamp deposits, both modulated per stamp by the Transfer curves.
 * 8-bit writes use stochastic rounding so glazes converge and falloffs
 * don't band. Dabs thinner than a pixel are drawn at 1 px with
 * proportionally less opacity, so tapers fade out instead of breaking up.
 *
 * Also:
 *   • All `DynamicCurve` modulation per stamp (size/angle/roundness/scatter
 *     /count/fg-bg/hue/sat/bright/purity, with sources pressure/velocity/
 *     tilt/rotation/direction/random/fade)
 *   • Scatter (perpendicular and both-axis offsets) + multi-stamp `count`
 *   • Tip flip-X / flip-Y jitter
 *   • Pose dynamics — pen tilt skew, pen-rotation follow, pressure squash
 *   • Wet edges — a stroke-level darkened rim around the painted silhouette,
 *     mimicking watercolor edge pooling
 *   • Paper-grain texture — fBm paper height (`paperTexture.ts`) multiplied
 *     into or subtracted from the coverage, in canvas or tip-local space
 *
 * Performance notes:
 *   - Inner pixel loop is monomorphic Number math.
 *   - Trig (cos/sin) and the inverse-rotation/squash matrix are hoisted out.
 *   - Paper-grain noise is reconstructed from a 32-bit hash — no lattice
 *     allocation. Cost is small enough to call inside the per-pixel loop
 *     without a measurable hit.
 *   - `blendPixelOver` early-outs on srcA ≤ 0, so we still call it without
 *     a coverage threshold check; we early-skip pixels with coverage ≤ 0
 *     locally because the function does meaningful pre-blend work.
 *   - The dirty-rect callback fires once per stamp, not per pixel, so the
 *     caller can union all stamp boxes into a single layer-dirty rect for a
 *     single GPU upload at the end of the stroke segment.
 */
import type {
  WebGPURenderer,
  GpuLayer,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import {
  blendPixelOver,
  type TouchedBuffer,
} from "../_shared/primitives";
import {
  getPixelOpsSync,
  runBrushStamp,
  beginBrushBatch,
  beginBrushBatchBitmap,
  appendBrushStamp,
  flushBrushBatch,
  ensureBakedBitmap,
  type BrushStampJob,
} from "@/wasm";
import type { DynamicCurve } from "@/types";

// True while `stampSegment` has an open WASM batch — read inside
// `applyStamp` to decide between `appendBrushStamp` (queue into the
// segment batch) and `runBrushStamp` (immediate single-stamp call,
// used for stampDot / build-up ticks that run outside a segment).
let brushStampBatchOpen = false;
// True when the open batch is the pre-rasterized *bitmap* path (the
// shape was static, so we baked it once and per-stamp blits the
// coverage). The bitmap kernel ignores motion-blur elongation by
// design; if this flag is set, `applyStamp` skips its motion gate so
// high-velocity stamps still flow through the bitmap dispatch instead
// of falling back to the JS path (which would silently bypass the open
// batch and tank perf).
let brushStampBatchIsBitmap = false;
import {
  linearToSrgbChannel,
  srgbToLinearChannel,
} from "@/utils/pixelFormatConvert";
import {
  dualProceduralCoverage,
  getCachedTipSampler,
  proceduralCoverage,
  sampleTipLevel,
  sweptRoundCoverage,
  tipLevelFor,
  type TipLevel,
  type TipSampler,
} from "./tipSampler";
import type { Brush, RGBAColor } from "@/types";
import {
  resolveDynamic,
  resolveSymmetric,
  shouldFlip,
  smoothNoise1D,
  stampHash,
  type StampInputs,
} from "./dynamicsResolver";
import { colorDynamicsInert, resolveStampColor } from "./colorJitter";
import { applyGrain, grainNoise } from "./paperTexture";
import { StrokeLayer, strokePixel, type StrokeStamp } from "./strokeLayer";
import { BM_NORMAL, blendModeId } from "./brushBlend";
import {
  pickUpSmudge,
  smudgePixel,
  type SmudgePatch,
  type SmudgeStamp,
} from "./smudgePatch";

interface SelMask {
  mask: Uint8Array;
  width: number;
}

export interface StrokeStampState {
  /** Deterministic seed for per-stroke jitter. Stable across previews. */
  strokeSeed: number;
  /** Monotonic stamp counter — used by `fade` source and per-stamp hash. */
  stampIndex: number;
  /** Arc length accumulated since the last emitted stamp. */
  arcAccum: number;
  /** Last emitted stamp position (canvas-space). */
  prevTipX: number;
  prevTipY: number;
  /** Diameter of the last emitted stamp; 0 before the first. */
  prevStampSize: number;
  /** Per-stroke "max coverage so far" buffer — prevents opacity accumulation
   *  within one stroke and is read by the wet-edges pass at stroke end. */
  touched: TouchedBuffer;
  /**
   * Inclusive canvas-space bbox of every pixel that any stamp in this stroke
   * touched. Lets the wet-edges pass scan only the stroke's footprint
   * instead of the entire canvas (which would be O(W·H) on the flat
   * `touched` buffer). `null` until the first stamp.
   */
  strokeBboxLx: number;
  strokeBboxLy: number;
  strokeBboxRx: number;
  strokeBboxRy: number;
  strokeBboxValid: boolean;
  /** True until the first stamp has been laid down. */
  isFirstStamp: boolean;
  /**
   * Stroke-level resolved color. Computed once at stroke start and reused
   * unless `colorDyn.perStamp` is true.
   */
  strokeColor: { r: number; g: number; b: number; a: number };
  /**
   * Smudge mode: the patch of pixels the brush is dragging along
   * (`smudgePatch.ts`). Null until the first stamp picks up the layer.
   */
  smudgePatch: SmudgePatch | null;
  /**
   * The stroke paint layer (blend modes, per-dab colour — `strokeLayer.ts`),
   * created by the caller for strokes that need it (`strokeLayerNeeds`).
   * Null = paint straight into the layer.
   */
  strokeLayer: StrokeLayer | null;
  /**
   * EMA-smoothed stroke direction in radians. The raw per-stamp Bézier
   * tangent jumps abruptly across segment boundaries and at sharp corners,
   * which makes a direction-following tip snap-rotate. Smoothing this in
   * sin/cos space (so the wrap-around at ±π doesn't break the average)
   * gives the tip a natural arc through corners.
   * Null until the first stamp.
   */
  smoothDirection: number | null;
  /**
   * Inter-stamp colour EMA. Each stamp paints a single uniform colour and
   * (at full opacity) overwrites the previous stamp's pixels — so even
   * with smooth-noise jitter, big swings produce a chain of differently
   * coloured "pills" along the stroke. We blend each stamp's resolved
   * colour with the previous stamp's so consecutive stamps differ only
   * marginally, and the optical result is a smooth gradient.
   * Null until the first stamp samples a colour.
   */
  prevStampColor: { r: number; g: number; b: number; a: number } | null;
  /** Per-stroke colour dynamics are resolved once, on the first stamp. */
  strokeColorResolved: boolean;
}

export function makeStrokeStampState(
  primary: RGBAColor,
  touched: TouchedBuffer,
  seed?: number,
): StrokeStampState {
  return {
    strokeSeed: seed ?? Math.floor(Math.random() * 0xffffffff),
    stampIndex: 0,
    arcAccum: 0,
    prevTipX: 0,
    prevTipY: 0,
    prevStampSize: 0,
    touched,
    isFirstStamp: true,
    strokeColor: {
      r: primary.r,
      g: primary.g,
      b: primary.b,
      a: primary.a,
    },
    smudgePatch: null,
    strokeLayer: null,
    smoothDirection: null,
    prevStampColor: null,
    strokeColorResolved: false,
    strokeBboxLx: 0,
    strokeBboxLy: 0,
    strokeBboxRx: 0,
    strokeBboxRy: 0,
    strokeBboxValid: false,
  };
}

/** Wrap an angle delta to (−π, π]. */
function wrapPi(d: number): number {
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Lerp pen pose (pressure/tilt/velocity/tiltAzimuth/rotation) at fraction
 * `t` between `a` and `b`. Linear lerp for magnitudes; shortest-arc lerp
 * for the angular components so wrap-around at ±π doesn't fling the
 * dynamic source halfway around the dial. `direction` is left as 0 — the
 * caller fills it from the Bézier tangent at each stamp position.
 */
function lerpPoseInto(
  out: StrokePoseInputs,
  a: StrokePoseInputs,
  b: StrokePoseInputs,
  t: number,
): StrokePoseInputs {
  out.pressure = a.pressure + (b.pressure - a.pressure) * t;
  out.velocity = a.velocity + (b.velocity - a.velocity) * t;
  out.tilt = a.tilt + (b.tilt - a.tilt) * t;
  out.tiltAzimuth = a.tiltAzimuth + wrapPi(b.tiltAzimuth - a.tiltAzimuth) * t;
  out.rotation = a.rotation + wrapPi(b.rotation - a.rotation) * t;
  out.direction = 0;
  return out;
}

/** Per-stamp pose scratch (stampSegment → emitStampWithCount). Poses are
 *  read synchronously and never retained, so one object each suffices;
 *  they must stay distinct (the smoothed pose is derived from the step's). */
function makePoseScratch(): StrokePoseInputs {
  return { pressure: 0, velocity: 0, tilt: 0, tiltAzimuth: 0, rotation: 0, direction: 0 };
}
const stepPoseScratch = makePoseScratch();
const smoothedPoseScratch = makePoseScratch();

/**
 * Step the smoothed direction toward `next` with a light EMA softening for
 * small wobbles plus a hard rate limit for sharp turns. The EMA-only
 * approach laggesthe brush rotation through corners and produces visible
 * "horn" artifacts as the tip paints at intermediate angles while still
 * positioned at the corner. A hard cap on the per-stamp rotation keeps
 * straight strokes lag-free (small deltas pass through unchanged) and
 * spreads sharp corners over a handful of stamps without the long tail.
 *
 * `easing` is the EMA-style weight applied to small deltas (`0..1`, higher
 * = more responsive). `maxStep` is the hard rate limit in radians per
 * stamp.
 */
function stepDirection(
  prev: number,
  next: number,
  easing: number,
  maxStep: number,
): number {
  const delta = wrapPi(next - prev);
  const eased = delta * easing;
  const stepped =
    eased > maxStep ? maxStep : eased < -maxStep ? -maxStep : eased;
  // Wrap result to (−π, π] for downstream callers that compare against the
  // raw next direction without wrapping.
  return wrapPi(prev + stepped);
}

/** Per-stamp resolved parameters — the engine computes one of these per stamp. */
interface ResolvedStamp {
  cx: number;
  cy: number;
  size: number; // canvas pixels (diameter)
  angle: number; // radians
  roundness: number; // 0..1 (1 = circle)
  flipX: 1 | -1;
  flipY: 1 | -1;
  /** Tilt-driven shear strength in tip-local x along y. 0 = no shear. */
  shear: number;
  /** Stretch factor along the stroke direction. 1 = no elongation. */
  motionElongation: number;
  /** Stroke direction in radians (used to orient the elongation). */
  motionDir: number;
  opacity: number; // 0..100 — the stroke ceiling for this stamp
  /** 0..1 — share of the ceiling this stamp deposits (Flow). */
  flow: number;
  /** 0..1 — paper-grain depth for this stamp (texture amount × dynamics). */
  grainAmount: number;
  /** Seeds the stochastic rounding of this stamp's 8-bit writes. */
  ditherSeed: number;
  /** Swept dab: the previous dab's centre relative to this one (canvas px)
   *  and its diameter. 0, 0 = a plain dab (see `sweepsDabs`). */
  sweepDx: number;
  sweepDy: number;
  sweepPrevSize: number;
  /** Resolved RGBA — float [0, 1+] for HDR. */
  fr: number;
  fg: number;
  fb: number;
  fa: number;
}

/**
 * Resolved dual-brush parameters for one stamp. Computed in
 * `emitStampWithCount` (where the resolved primary angle and stroke
 * direction are known) and consumed by `applyStamp`'s inner pixel loop.
 */
interface DualResolved {
  sampler: TipSampler;
  /** Total dual angle = primary stamp angle + dualTip.angle (+ stroke direction
   *  if `directionFollow`). The dual tip is sampled in this rotated frame. */
  baseAngle: number;
  /** Dual tip diameter as a fraction of the primary tip's diameter. */
  sizeRatio: number;
  /** 0..1 mix between identity (no effect) and full multiply. */
  mix: number;
}

/** Per-stamp pen / stroke inputs from brush.tsx. */
export interface StrokePoseInputs {
  pressure: number;
  /** Pen tilt magnitude 0..1. */
  tilt: number;
  /** Tilt direction in radians (atan2 of tiltY/tiltX). */
  tiltAzimuth: number;
  /** Pen rotation in radians (twist * π/180). */
  rotation: number;
  /** Stroke heading in radians at this stamp. */
  direction: number;
  /** Smoothed velocity 0..1 (1 ≈ 5 px/ms). */
  velocity: number;
}

export interface StampSegmentParams {
  renderer: WebGPURenderer;
  layer: GpuLayer;
  layers: GpuLayer[];
  brush: Brush;
  sampler: TipSampler;
  /** Segment endpoints and control point in canvas space. */
  p0x: number;
  p0y: number;
  cpx: number;
  cpy: number;
  p1x: number;
  p1y: number;
  /** Tapered base size and opacity at p0 → p1 (before dynamics). */
  size0: number;
  size1: number;
  opacity0: number;
  opacity1: number;
  /** Foreground colour (primary). */
  primary: RGBAColor;
  /** Background colour (secondary) — used by fg/bg jitter. */
  secondary: RGBAColor;
  selectionMask: Uint8Array | null;
  tiledMode: boolean;
  state: StrokeStampState;
  /**
   * Pen pose at the segment endpoints. The engine lerps pressure/tilt/
   * velocity/tiltAzimuth/rotation per-stamp between these two snapshots so
   * pose-driven dynamics (size, color, scatter, …) vary smoothly along the
   * stroke instead of stepping at each pointer-event boundary. `direction`
   * is overridden per-stamp from the Bézier tangent and can be left 0.
   * For dot-style emissions (pointer-down dot, build-up tick) pass the
   * same snapshot for both.
   */
  pose0: StrokePoseInputs;
  pose1: StrokePoseInputs;
  /**
   * Called for each emitted stamp's canvas-space bounding rect. Caller is
   * expected to union these into the layer's dirtyRect for a single GPU
   * upload at the end of the segment.
   */
  onStampBbox?: (minX: number, minY: number, maxX: number, maxY: number) => void;
  /**
   * Optional override for spacing — defaults to brush.tip.spacing. The
   * existing painter calls this with a min-size-based spacing for tapered
   * stroke ends; pass undefined to use brush settings.
   */
  spacingOverride?: number;
  /**
   * If true, force the first sample on this segment to emit a stamp
   * regardless of arc accumulation. Used for stroke start.
   */
  forceFirst?: boolean;
}

// ─── Per-stamp scratch (applyStamp) ──────────────────────────────────────────
// applyStamp runs once per dab (thousands per stroke). These module-level
// objects replace the per-stamp allocations (selection wrapper, linear
// colour tuple, ~50-field WASM job). Safe to reuse: every consumer
// (blendPixelOver, appendBrushStamp / runBrushStamp) reads them
// synchronously and keeps no reference. Every field is assigned per stamp.
const stampSelScratch: SelMask = { mask: new Uint8Array(0), width: 0 };
const stampSrcFloatScratch: [number, number, number, number] = [0, 0, 0, 0];
const stampJobScratch: BrushStampJob = {
  cx: 0, cy: 0, radius: 0, roundness: 1, angle: 0, shear: 0,
  flipX: 1, flipY: 1, aa: true, softness: 0,
  minX: 0, minY: 0, maxX: 0, maxY: 0,
  tipKind: 0, tipData: undefined, tipW: undefined, tipH: undefined,
  r: 0, g: 0, b: 0, a: 0, fr: 0, fg: 0, fb: 0, fa: 0,
  opacity: 0, capOpacity: -1, bypassCap: false,
  layerData: new Uint8Array(0), layerOffsetX: 0, layerOffsetY: 0,
  layerW: 0, layerH: 0, layerFormat: 0, layerWasmPtr: undefined,
  touchedData: new Uint8Array(0), touchedW: 0, touchedH: 0,
  touchedWasmPtr: undefined, selMask: undefined, canvasW: 0, canvasH: 0,
  dualActive: false, dualTipKind: undefined, dualSizeRatio: undefined,
  dualBaseAngle: undefined, dualMix: undefined, dualTipData: undefined,
  dualTipW: undefined, dualTipH: undefined,
  grainAmount: 0, grainScale: 2, grainFollowBrush: false, grainMode: 0,
  ditherSeed: 0, sweepDx: 0, sweepDy: 0, sweepR0: 1, blendMode: 0, strokeFlags: 0,
  bmOffsetX: undefined, bmOffsetY: undefined,
};

/** Per-stamp stroke-layer context of the JS paint path. */
const strokeStampScratch: StrokeStamp = {
  layer: null as unknown as StrokeLayer,
  blendMode: BM_NORMAL,
  srcAlphaScale: 0,
  capAlphaScale: -1,
  color: [0, 0, 0],
  ditherSeed: 0,
};

/**
 * Whether a stroke with `brush` needs the stroke paint layer, and whether
 * it must keep a per-pixel colour: a non-Normal blend mode, or colour that
 * changes from dab to dab. Smudge strokes paint their own way. Null = the
 * stroke can paint straight into the layer (the exact same result for one
 * colour in Normal mode, and faster).
 */
export function strokeLayerNeeds(brush: Brush): { recolor: boolean } | null {
  if (brush.smudge.enabled) return null;
  const recolor = brush.colorDyn.perStamp && !colorDynamicsInert(brush.colorDyn);
  const blended = (brush.blendMode ?? "normal") !== "normal";
  return recolor || blended ? { recolor } : null;
}

/** Per-stamp smudge context (read synchronously by `applyStamp`). */
const smudgeStampScratch: SmudgeStamp = {
  patch: { data: new Float32Array(0), size: 0 },
  cx: 0,
  cy: 0,
  colorRate: 0,
  brush: [0, 0, 0, 0],
};

// Tip density levels fixed for the segment being stamped (bitmap tips). A
// segment batch shares one level per tip, so every stamp in the segment —
// batched or not — samples the same one. Null outside `stampSegment`: the
// stamp picks the level for its own size.
let segmentTipLevel: TipLevel | null = null;
let segmentDualLevel: TipLevel | null = null;

/** Dabs thinner than this radius are drawn at it with proportionally less
 *  opacity, so pressure tapers fade out instead of breaking into gaps and
 *  then vanishing (a sub-pixel dab covers no pixel centre). Linear in the
 *  radius: along a line the dabs don't accumulate, so a line of width w < 1
 *  reads as a 1 px line at w × the opacity. */
const MIN_DAB_RADIUS = 0.5;

/**
 * Correlation length for the smooth `random` source, in stamps. A new noise
 * sample is interpolated every ~6 stamps, which translates to roughly one
 * brush-diameter at default spacing — short enough that variation is visible
 * along a stroke, long enough that adjacent stamps don't strobe.
 */
const NOISE_CORRELATION_STAMPS = 6;

/** Compose StampInputs from stroke pose + per-stamp counters. */
function makeStampInputs(
  pose: StrokePoseInputs,
  state: StrokeStampState,
  countSubindex: number,
): StampInputs {
  // The hash mixes the stroke seed, stamp index AND the count subindex so
  // multiple stamps emitted for the same spacing step (count > 1) get
  // independent jitter values without disturbing the deterministic-replay
  // invariant for any single (strokeSeed, stampIndex) sequence.
  const hash = stampHash(
    state.strokeSeed ^ (countSubindex * 0xa1b2c3d4),
    state.stampIndex,
  );
  // Smooth noise sample for the `random` source. The `+ countSubindex × 0.137`
  // offset gives sub-stamps in a scatter group different noise samples even
  // though they share a stampIndex — without it, all sub-stamps would have
  // identical size/colour jitter.
  const noiseT =
    (state.stampIndex + countSubindex * 0.137) / NOISE_CORRELATION_STAMPS;
  const noiseSample = smoothNoise1D(noiseT, state.strokeSeed);
  return {
    pressure: pose.pressure,
    velocity: pose.velocity,
    tilt: pose.tilt,
    rotation: pose.rotation / (2 * Math.PI),
    // pose.direction is wrapped to (-π, π]; curves read [0, 1], so wrap
    // instead of dividing (leftward/upward strokes used to clamp to 0).
    direction: (((pose.direction / (2 * Math.PI)) % 1) + 1) % 1,
    stampIndex: state.stampIndex,
    hash,
    noiseSample,
  };
}

/**
 * Resolve all per-stamp parameters for one emitted stamp.
 *
 * `baseSize` and `baseOpacity` come from the spline-walk taper; this function
 * applies the dynamic curves on top.
 */
function resolveStamp(
  brush: Brush,
  baseSize: number,
  baseOpacity: number,
  baseCx: number,
  baseCy: number,
  primary: RGBAColor,
  secondary: RGBAColor,
  pose: StrokePoseInputs,
  state: StrokeStampState,
  countSubindex: number,
): ResolvedStamp {
  const inputs = makeStampInputs(pose, state, countSubindex);

  // ─── Size ────────────────────────────────────────────────────────────────
  const sizeMul = resolveDynamic(brush.shapeDyn.sizeJitter, inputs);
  const size = Math.max(1, baseSize * sizeMul);

  // ─── Angle ───────────────────────────────────────────────────────────────
  // Order: stroke direction (if "follow stroke") gives the baseline; user's
  // tip.angle is layered on as a constant offset (so a captured calligraphy
  // nib can be tuned to point ahead, perpendicular, etc.); angleJitter swings
  // around that. Pen-rotation follow, when enabled, overrides everything
  // because barrel rotation is an explicit gesture from the user.
  const angleSwing = resolveSymmetric(brush.shapeDyn.angleJitter, inputs);
  let baseAngle = brush.tip.angle;
  if (brush.pose.directionFollow) {
    baseAngle += pose.direction;
  }
  let angle = baseAngle + angleSwing * Math.PI; // ±180° at jitter=1
  if (brush.pose.rotationFollow) {
    angle = pose.rotation;
  }

  // ─── Roundness (with pose pressureSquash) ────────────────────────────────
  const roundnessMul = resolveDynamic(brush.shapeDyn.roundnessJitter, inputs);
  let roundness = Math.max(0.05, Math.min(1, brush.tip.roundness * roundnessMul));
  if (brush.pose.pressureSquash > 0) {
    const squash = 1 - brush.pose.pressureSquash * (1 - pose.pressure);
    roundness = Math.max(0.05, roundness * squash);
  }

  // ─── Tilt-driven shear (skew) ────────────────────────────────────────────
  // A tilted pen "leans" the tip — we model this as a horizontal shear in
  // tip-local space, oriented along the tilt azimuth. shear = tiltScale × tilt
  // × cos(azimuth_relative_to_tip_x). This keeps a flat round tip at zero
  // tilt while producing a chiselled feel as the pen leans.
  let shear = 0;
  if (brush.pose.tiltScale > 0 && pose.tilt > 0) {
    shear = brush.pose.tiltScale * pose.tilt * Math.cos(pose.tiltAzimuth - angle);
  }

  // ─── Flip ────────────────────────────────────────────────────────────────
  const flipX = shouldFlip(brush.tip.flipXJitter, inputs.hash, 1) ? -1 : 1;
  const flipY = shouldFlip(brush.tip.flipYJitter, inputs.hash, 2) ? -1 : 1;

  // ─── Scatter offset ──────────────────────────────────────────────────────
  let cx = baseCx;
  let cy = baseCy;
  if (brush.scatter.amount > 0) {
    // amount is multiples of tip diameter; jitterMul scales it by the curve
    const jitterMul = resolveDynamic(brush.scatter.jitter, inputs);
    const radius = baseSize * 0.5 * brush.scatter.amount * jitterMul;
    // Random direction (use hash for x and a salted hash for y).
    const a = ((inputs.hash >>> 0) / 0x100000000) * Math.PI * 2;
    // The sub-stamp index is mixed in so count > 1 stamps get independent
    // distances (they all landed on the same spot / ring before).
    const rh = stampHash(
      state.strokeSeed ^ 0xdeadbeef ^ Math.imul(countSubindex + 1, 0x9e3779b1),
      state.stampIndex,
    );
    const r = (rh >>> 0) / 0x100000000;
    if (brush.scatter.bothAxes) {
      cx += Math.cos(a) * radius * r;
      cy += Math.sin(a) * radius * r;
    } else {
      // Perpendicular to stroke direction only
      const px = -Math.sin(pose.direction);
      const py = Math.cos(pose.direction);
      const swing = (r * 2 - 1) * radius;
      cx += px * swing;
      cy += py * swing;
    }
  }

  // ─── Transfer: opacity ceiling + flow ────────────────────────────────────
  // Opacity caps what the stroke can reach at any pixel; flow is the share
  // of that ceiling each stamp deposits. Both follow their Transfer curves
  // (pen pressure → lighter line / slower build-up). Older brushes have no
  // `transfer` group or `flow`: off and 100.
  let opacity = Math.max(0, Math.min(100, baseOpacity));
  let flow = Math.max(0, Math.min(100, brush.tip.flow ?? 100)) / 100;
  const transfer = brush.transfer;
  if (transfer) {
    opacity *= resolveDynamic(transfer.opacityJitter, inputs);
    flow *= resolveDynamic(transfer.flowJitter, inputs);
  }

  // ─── Paper-grain depth ───────────────────────────────────────────────────
  let grainAmount = Math.max(0, Math.min(1, brush.texture.amount));
  const depthJitter = brush.texture.depthJitter;
  if (grainAmount > 0 && depthJitter) {
    grainAmount *= resolveDynamic(depthJitter, inputs);
  }

  // ─── Color ───────────────────────────────────────────────────────────────
  let fr: number, fg: number, fb: number, fa: number;
  // Inert dynamics: the colour is the stroke colour — skip the OKLab round
  // trip (it ran on every stamp of the default brush, allocating and
  // clamping HDR primaries for nothing).
  const colorInert = colorDynamicsInert(brush.colorDyn);
  if (brush.colorDyn.perStamp && !colorInert) {
    const resolved = resolveStampColor(primary, secondary, brush.colorDyn, inputs);
    fr = resolved.r;
    fg = resolved.g;
    fb = resolved.b;
    fa = resolved.a;
  } else {
    if (!colorInert && !state.strokeColorResolved) {
      // Per-stroke jitter: resolve once for the whole stroke (this was
      // documented but never done — per-stroke jitter had no effect).
      const resolved = resolveStampColor(
        primary,
        secondary,
        brush.colorDyn,
        inputs,
      );
      state.strokeColor = {
        r: resolved.r,
        g: resolved.g,
        b: resolved.b,
        a: resolved.a,
      };
    }
    state.strokeColorResolved = true;
    fr = state.strokeColor.r;
    fg = state.strokeColor.g;
    fb = state.strokeColor.b;
    fa = state.strokeColor.a;
  }

  // ─── Motion-blur elongation along stroke direction ──────────────────────
  // brush.motionBlur is 0..100. 0 → no elongation; 100 → 4× along-stroke
  // stretch, producing a clearly smeared / calligraphic feel. Skipped at
  // very low velocities so a slow paint doesn't get an unwanted streak.
  // Elongation ramps with velocity (full at 25% of tracking speed) instead
  // of switching on at a threshold — that step made a stroke alternate
  // between elongated JS stamps and round WASM stamps. Below
  // MOTION_BLUR_MIN the stretch (≤ 1.2×) is imperceptible and treated as
  // off on every path, so default brushes keep the WASM batch.
  let motionElongation = 1;
  const motionBlur = effectiveMotionBlur(brush);
  if (motionBlur > 0 && pose.velocity > 0.01) {
    const k = motionBlur / 100;
    const v = Math.min(1, (pose.velocity - 0.01) / 0.24);
    motionElongation = 1 + k * 3 * v;
  }

  return {
    cx,
    cy,
    size,
    angle,
    roundness,
    flipX,
    flipY,
    shear,
    motionElongation,
    motionDir: pose.direction,
    opacity,
    flow,
    grainAmount,
    ditherSeed: inputs.hash | 0,
    sweepDx: 0,
    sweepDy: 0,
    sweepPrevSize: 0,
    fr,
    fg,
    fb,
    fa,
  };
}

/** Motion blur below this percentage (≤ 1.2× elongation) is treated as off. */
const MOTION_BLUR_MIN = 7;

/** The brush's motion blur, or 0 when it is too small to be visible. */
function effectiveMotionBlur(brush: Brush): number {
  return brush.motionBlur >= MOTION_BLUR_MIN ? brush.motionBlur : 0;
}

/** The bitmap batch places stamps on whole pixels. That half-pixel snap is
 *  only invisible when the stamp is big and its edge fades over at least
 *  this many pixels (soft brushes — exactly the ones the batch speeds up);
 *  hard procedural tips use the per-stamp batch, which positions stamps at
 *  sub-pixel precision so their edges stay smooth. */
const BITMAP_BATCH_MIN_SIZE = 16;
const BITMAP_BATCH_MIN_FALLOFF_PX = 2;

/** A `DynamicCurve` whose output is constant 1 for every stamp (so it
 *  doesn't vary the underlying value). */
function curveIsInert(c: DynamicCurve): boolean {
  return c.jitter <= 0 || c.source === "off";
}

/**
 * True when every per-stamp shape parameter (size, angle, roundness,
 * flip, shear) is identical across a segment. When this holds we can
 * pre-rasterize the brush coverage into a bitmap ONCE and per-stamp
 * just blit it — eliminates the per-pixel SDF + AA + dual + grain
 * compute that dominates soft-brush cost. See
 * `src/wasm/brushStamp.ts#ensureBakedBitmap` for the bake path.
 *
 * Conservative on purpose: when in doubt we fall back to the SDF
 * batch, which is still fast and correct for every brush configuration.
 */
function isShapeStaticSegment(
  brush: Brush,
  size0: number,
  size1: number,
): boolean {
  if (Math.abs(size0 - size1) > 0.001) return false; // intra-segment taper
  if (brush.pressureSize) return false;              // pressure varies → size varies
  if (!curveIsInert(brush.shapeDyn.sizeJitter)) return false;
  if (!curveIsInert(brush.shapeDyn.angleJitter)) return false;
  if (!curveIsInert(brush.shapeDyn.roundnessJitter)) return false;
  if (brush.tip.flipXJitter > 0) return false;
  if (brush.tip.flipYJitter > 0) return false;
  if (brush.pose.directionFollow) return false;
  if (brush.pose.rotationFollow) return false;
  if (brush.pose.pressureSquash !== 0) return false;
  if (brush.pose.tiltScale !== 0) return false;
  // Dual brush following the stroke direction would vary its angle.
  const dt = brush.dualTip;
  if (dt && dt.enabled && dt.mix > 0 && dt.sizeRatio > 0 && dt.directionFollow) {
    return false;
  }
  // Tip-local grain is baked into the bitmap, which only works when it is
  // the same for every stamp: multiply mode (subtract depends on each
  // stamp's opacity) with a constant depth.
  if (brush.texture.amount > 0 && brush.texture.followBrush) {
    if ((brush.texture.mode ?? "multiply") === "subtract") return false;
    if (brush.texture.depthJitter && !curveIsInert(brush.texture.depthJitter)) {
      return false;
    }
  }
  return true;
}

/** Hardness → falloff depth as a fraction of the radius. */
function brushSoftness(brush: Brush): number {
  return 1 - Math.max(0, Math.min(100, brush.tip.hardness)) / 100;
}

/** Spacing (% of the diameter) up to which round dabs are swept. Wider
 *  spacing is a deliberate beaded / dotted line. */
const SWEEP_MAX_SPACING = 50;

/**
 * Round-tip strokes draw each dab as a capsule from the previous dab's
 * centre instead of a disc: discrete discs leave a ripple between dab
 * centres (visible as stripes along soft strokes, scallops along hard
 * edges); the capsules join into the continuous stroke at any spacing.
 * Only at full flow without smudge: accumulating stamps deposit per dab
 * (see `applyStamp`). Not for scattered or multi-stamp dabs (no meaningful
 * previous centre) or non-round tips (their swept shape isn't a distance
 * to a segment).
 */
function sweepsDabs(brush: Brush, sampler: TipSampler): boolean {
  return (
    sampler.tipKind === 0 &&
    brush.tip.spacing <= SWEEP_MAX_SPACING &&
    (brush.tip.flow ?? 100) >= 100 &&
    !(brush.transfer && !curveIsInert(brush.transfer.flowJitter)) &&
    !brush.smudge.enabled &&
    brush.scatter.amount <= 0 &&
    brush.scatter.count <= 1 &&
    curveIsInert(brush.scatter.countJitter)
  );
}

/**
 * Apply one fully-resolved stamp at (cx, cy) — canvas space, pixel centres
 * at integer coordinates. Dispatches to the WASM kernel when it can; the JS
 * loop below is the fallback (tiled mode, smudge, motion blur, WASM not yet
 * loaded) and mirrors the kernel's coverage and blend math.
 */
function applyStamp(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  brush: Brush,
  sampler: TipSampler,
  s: ResolvedStamp,
  selectionMask: Uint8Array | null,
  tiledMode: boolean,
  touched: TouchedBuffer,
  /** When true, consecutive stamps re-blend over each other (smudge / build-up
   *  ticks). The `touched` map is still updated, so wet edges still work. */
  bypassCap: boolean,
  onStampBbox: ((minX: number, minY: number, maxX: number, maxY: number) => void) | undefined,
  /** Optional dual-brush mask sampled per-pixel and multiplied into primary
   *  coverage. `null` when disabled — engine skips the entire dual path. */
  dual: DualResolved | null,
  /** Smudge mode: the carried patch this stamp paints instead of a colour. */
  smudge: SmudgeStamp | null = null,
  /** The stroke paint layer to paint through (null = straight into the layer). */
  strokeLayer: StrokeLayer | null = null,
): void {
  let radius = s.size * 0.5;
  if (!(radius > 0)) return;
  // Sub-pixel dabs: draw at the minimum radius with the opacity scaled down
  // (see MIN_DAB_RADIUS), so the stroke thins into a fading hairline.
  let ceiling = s.opacity;
  if (radius < MIN_DAB_RADIUS) {
    ceiling *= radius / MIN_DAB_RADIUS;
    radius = MIN_DAB_RADIUS;
  }
  if (ceiling <= 0) return;
  const {
    angle,
    roundness,
    flipX,
    flipY,
    shear,
    cx,
    cy,
    motionElongation,
    motionDir,
  } = s;
  // Flow vs Opacity: `ceiling` is the per-stroke cap at any pixel; each
  // stamp deposits `flow` of it, building toward the cap across overlapping
  // stamps. At full flow the deposit is the cap (first contact reaches it).
  const flow = Math.max(0, Math.min(1, s.flow));
  const fullFlow = flow >= 0.9999;
  const stampOpacity = fullFlow ? ceiling : ceiling * flow;
  // Swept dab: replaces the max-of-dabs coverage of a full-flow stroke with
  // the continuous one. Not for accumulating stamps (flow, smudge), which
  // deposit per dab — sweeping them adds the segment end caps at discrete
  // spots — nor with motion blur (its elongation is about the centre).
  const sweeping =
    (s.sweepDx !== 0 || s.sweepDy !== 0) &&
    sampler.tipKind === 0 &&
    fullFlow &&
    !bypassCap &&
    motionElongation <= 1.0001;
  const sweepDx = sweeping ? s.sweepDx : 0;
  const sweepDy = sweeping ? s.sweepDy : 0;
  const sweepR0 = sweeping
    ? Math.max(MIN_DAB_RADIUS, s.sweepPrevSize * 0.5) / radius
    : 1;
  const aa = brush.antiAlias;
  const softness = brushSoftness(brush);
  const cosT = Math.cos(angle);
  const sinT = Math.sin(angle);
  // Bounding box: the rotated tip-local box — x: radius plus shear, y:
  // radius × roundness — which contains round, square, diamond and bitmap
  // tips alike, stretched along the stroke by motion blur, plus the
  // anti-aliased edge (half a pixel) and a pixel of margin. Soft tips fade
  // out inside the radius, so hardness never widens it.
  const cosD = Math.cos(motionDir);
  const sinD = Math.sin(motionDir);
  const reachR = radius * Math.max(1, sweepR0);
  const tipHX = reachR + Math.abs(shear) * reachR * roundness;
  const tipHY = reachR * roundness;
  const absCosT = Math.abs(cosT);
  const absSinT = Math.abs(sinT);
  const stretch = radius * (motionElongation - 1);
  const halfX = Math.ceil(
    absCosT * tipHX + absSinT * tipHY + Math.abs(cosD) * stretch + 1.5,
  );
  const halfY = Math.ceil(
    absSinT * tipHX + absCosT * tipHY + Math.abs(sinD) * stretch + 1.5,
  );
  // A swept dab spans its segment from the previous centre.
  const minX = Math.floor(cx + Math.min(0, sweepDx) - halfX);
  const maxX = Math.ceil(cx + Math.max(0, sweepDx) + halfX);
  const minY = Math.floor(cy + Math.min(0, sweepDy) - halfY);
  const maxY = Math.ceil(cy + Math.max(0, sweepDy) + halfY);

  if (!tiledMode) {
    if (
      maxX < 0 ||
      maxY < 0 ||
      minX >= renderer.pixelWidth ||
      minY >= renderer.pixelHeight
    )
      return;
  }
  if (onStampBbox) onStampBbox(minX, minY, maxX, maxY);
  // Stroke paint layer: snapshot the stroke-start pixels of every tile this
  // stamp can touch before it (or any queued stamp) paints there.
  const viaStroke = strokeLayer !== null && smudge === null;
  if (viaStroke) strokeLayer.ensure(layer, minX, minY, maxX, maxY, tiledMode);

  // Float colour → 0..255 bytes for the rgba8 path.
  const r = Math.round(Math.min(s.fr, 1) * 255);
  const g = Math.round(Math.min(s.fg, 1) * 255);
  const b = Math.round(Math.min(s.fb, 1) * 255);
  const a = Math.round(Math.min(Math.max(s.fa, 0), 1) * 255);
  // Stamp colour `s.fr/fg/fb` is sRGB-encoded (it descends from primaryColor
  // with per-stamp jitter applied). An rgba32f layer stores linear light.
  let srcFloat: readonly [number, number, number, number] | undefined;
  if (layer.format === "rgba32f") {
    stampSrcFloatScratch[0] = srgbToLinearChannel(s.fr);
    stampSrcFloatScratch[1] = srgbToLinearChannel(s.fg);
    stampSrcFloatScratch[2] = srgbToLinearChannel(s.fb);
    stampSrcFloatScratch[3] = s.fa;
    srcFloat = stampSrcFloatScratch;
  }

  // Bitmap tips: the density level for this dab size (fixed per segment).
  const levels = sampler.levels;
  const tipLevel =
    levels !== undefined
      ? segmentTipLevel ?? tipLevelFor(levels, radius * 2)
      : null;
  const dualRadius = dual !== null ? radius * dual.sizeRatio : 0;
  const dualLevel =
    dual !== null && dual.sampler.levels !== undefined
      ? segmentDualLevel ?? tipLevelFor(dual.sampler.levels, dualRadius * 2)
      : null;

  const grainAmount = s.grainAmount;
  const grainScale = Math.max(2, brush.texture.scale);
  const grainSubtract = (brush.texture.mode ?? "multiply") === "subtract";
  const grainFollowsBrush = brush.texture.followBrush;

  // ─── WASM fast path ──────────────────────────────────────────────────────
  // The C++ kernel (wasm/src/brush_stamp.cpp) handles everything except
  // smudge (stateful pickup), motion-blur elongation (unless a bitmap batch
  // is open — that path ignores motion blur by design), tiled mode and
  // indexed8. The module loads async at startup; until then we use JS.
  const motionBlocksWasm =
    motionElongation > 1.0001 &&
    !(brushStampBatchOpen && brushStampBatchIsBitmap);
  const wasmEligible =
    !bypassCap &&
    !motionBlocksWasm &&
    !tiledMode &&
    layer.format !== "indexed8" &&
    // The kernel reads a stroke layer only in place (its tiles in the heap,
    // layer and coverage buffer pinned).
    (!viaStroke ||
      (strokeLayer.wasm !== null &&
        layer.wasmPtr !== undefined &&
        touched.wasmPtr !== undefined));
  const wasmModule = wasmEligible ? getPixelOpsSync() : null;
  if (wasmModule !== null) {
    // Inside a segment batch the stamp is queued and applied when the
    // segment flushes; outside one (stampDot, build-up tick) it runs now.
    const dispatch = brushStampBatchOpen ? appendBrushStamp : runBrushStamp;
    const isF32 = layer.format === "rgba32f";
    const j = stampJobScratch;
    j.cx = cx;
    j.cy = cy;
    j.radius = radius;
    j.roundness = roundness;
    j.angle = angle;
    j.shear = shear;
    j.flipX = flipX;
    j.flipY = flipY;
    j.aa = aa;
    j.softness = softness;
    j.minX = minX;
    j.minY = minY;
    j.maxX = maxX;
    j.maxY = maxY;
    j.tipKind = sampler.tipKind;
    j.tipData = tipLevel?.data;
    j.tipW = tipLevel?.w;
    j.tipH = tipLevel?.h;
    j.r = r;
    j.g = g;
    j.b = b;
    j.a = a;
    // rgba32f: the kernel writes the floats straight into the layer, so
    // they must already be linear-light (same as the JS srcFloat path).
    j.fr = isF32 ? stampSrcFloatScratch[0] : s.fr;
    j.fg = isF32 ? stampSrcFloatScratch[1] : s.fg;
    j.fb = isF32 ? stampSrcFloatScratch[2] : s.fb;
    j.fa = s.fa;
    j.opacity = stampOpacity;
    // Full flow: the deposit is the cap, so the kernel takes its
    // "stamp == cap" branch (capOpacity = -1).
    j.capOpacity = fullFlow ? -1 : ceiling;
    j.bypassCap = false;
    j.layerData = layer.data;
    j.layerOffsetX = layer.offsetX;
    j.layerOffsetY = layer.offsetY;
    j.layerW = layer.layerWidth;
    j.layerH = layer.layerHeight;
    j.layerFormat = isF32 ? 1 : 0;
    // Zero-copy when both buffers live in the WASM heap.
    j.layerWasmPtr = layer.wasmPtr;
    j.touchedData = touched.data;
    j.touchedW = touched.width;
    j.touchedH = touched.height;
    j.touchedWasmPtr = touched.wasmPtr;
    j.selMask = selectionMask ?? undefined;
    j.canvasW = renderer.pixelWidth;
    j.canvasH = renderer.pixelHeight;
    // Dual brush — baseAngle is already the rotated total
    // (primary angle + dual.angle + direction follow).
    j.dualActive = dual !== null;
    j.dualTipKind = dual?.sampler.tipKind;
    j.dualSizeRatio = dual?.sizeRatio;
    j.dualBaseAngle = dual?.baseAngle;
    j.dualMix = dual?.mix;
    j.dualTipData = dualLevel?.data;
    j.dualTipW = dualLevel?.w;
    j.dualTipH = dualLevel?.h;
    j.grainAmount = grainAmount;
    j.grainScale = grainScale;
    j.grainFollowBrush = grainFollowsBrush;
    j.grainMode = grainSubtract ? 1 : 0;
    j.ditherSeed = s.ditherSeed;
    j.sweepDx = sweepDx;
    j.sweepDy = sweepDy;
    j.sweepR0 = sweepR0;
    j.blendMode = blendModeId(brush.blendMode);
    j.strokeFlags = viaStroke ? 1 | (strokeLayer.recolor ? 2 : 0) : 0;
    // Set by appendBrushStamp in bitmap mode; never carry a stale offset.
    j.bmOffsetX = undefined;
    j.bmOffsetY = undefined;
    dispatch(wasmModule, j);
    return;
  }

  let sel: SelMask | undefined;
  if (selectionMask !== null) {
    stampSelScratch.mask = selectionMask;
    stampSelScratch.width = renderer.pixelWidth;
    sel = stampSelScratch;
  }
  const tiledW = tiledMode ? renderer.pixelWidth : undefined;
  const tiledH = tiledMode ? renderer.pixelHeight : undefined;

  const invRadius = 1 / radius;
  const invRadiusY = 1 / (radius * roundness);
  const tipKind = sampler.tipKind;
  // Segment start in tip-local unit coords (same transform as the pixels).
  let sweepU = 0;
  let sweepV = 0;
  if (sweeping) {
    let lx = sweepDx * cosT + sweepDy * sinT;
    const ly = -sweepDx * sinT + sweepDy * cosT;
    lx -= shear * ly;
    sweepU = lx * flipX * invRadius;
    sweepV = ly * flipY * invRadiusY;
  }
  // Subtract grain removes a fixed depth from the paint alpha (1/ceiling).
  const invAlpha = 1 / Math.max(1e-3, Math.max(0, s.fa) * (ceiling / 100));
  const grainEnabled = grainAmount > 0;

  // Inverse motion-blur transform: rotate into the stroke-aligned frame,
  // compress along-stroke by 1/elongation, rotate back.
  const motionActive = motionElongation > 1.0001;
  const invElong = motionActive ? 1 / motionElongation : 1;

  // Dual-brush transform: rotate by `dual.baseAngle`, scale by 1/dualRadius.
  // Skipped when the dual radius is sub-pixel (no visible effect).
  const dualActive = dual !== null && dualRadius >= 0.5;
  const dualInvR = dualActive ? 1 / dualRadius : 0;
  const dualCosT = dualActive ? Math.cos(dual!.baseAngle) : 1;
  const dualSinT = dualActive ? Math.sin(dual!.baseAngle) : 0;
  const dualMix = dualActive ? dual!.mix : 0;
  const dualKind = dualActive ? dual!.sampler.tipKind : 0;

  if (smudge !== null) {
    // Brush colour, premultiplied, in the layer's value space.
    const lin = layer.format === "rgba32f";
    const fa = Math.max(0, Math.min(1, s.fa));
    smudge.brush[0] = (lin ? srgbToLinearChannel(s.fr) : Math.min(1, s.fr)) * fa;
    smudge.brush[1] = (lin ? srgbToLinearChannel(s.fg) : Math.min(1, s.fg)) * fa;
    smudge.brush[2] = (lin ? srgbToLinearChannel(s.fb) : Math.min(1, s.fb)) * fa;
    smudge.brush[3] = fa;
  }
  const canvasW = renderer.pixelWidth;
  const canvasH = renderer.pixelHeight;
  let strokeSt: StrokeStamp | null = null;
  if (viaStroke) {
    strokeSt = strokeStampScratch;
    strokeSt.layer = strokeLayer;
    strokeSt.blendMode = blendModeId(brush.blendMode);
    const colorA =
      layer.format === "rgba32f" ? Math.max(0, Math.min(1, s.fa)) : a / 255;
    strokeSt.srcAlphaScale = colorA * (stampOpacity / 100);
    strokeSt.capAlphaScale = fullFlow ? -1 : colorA * (ceiling / 100);
    // Dab colour in the layer's value space (the rgba8 kernel uses bytes).
    if (layer.format === "rgba32f") {
      strokeSt.color[0] = stampSrcFloatScratch[0];
      strokeSt.color[1] = stampSrcFloatScratch[1];
      strokeSt.color[2] = stampSrcFloatScratch[2];
    } else {
      strokeSt.color[0] = r / 255;
      strokeSt.color[1] = g / 255;
      strokeSt.color[2] = b / 255;
    }
    strokeSt.ditherSeed = s.ditherSeed;
  }

  for (let py = minY; py <= maxY; py++) {
    const dyBase0 = py - cy;
    for (let px = minX; px <= maxX; px++) {
      const dxBase0 = px - cx;
      let dxBase = dxBase0;
      let dyBase = dyBase0;
      if (motionActive) {
        const along = dxBase0 * cosD + dyBase0 * sinD;
        const cross = -dxBase0 * sinD + dyBase0 * cosD;
        const alongShrunk = along * invElong;
        dxBase = alongShrunk * cosD - cross * sinD;
        dyBase = alongShrunk * sinD + cross * cosD;
      }
      // Inverse rotation into tip-local axes, tilt shear, flip.
      let lx = dxBase * cosT + dyBase * sinT;
      let ly = -dxBase * sinT + dyBase * cosT;
      lx -= shear * ly;
      lx *= flipX;
      ly *= flipY;
      const u = lx * invRadius;
      const v = ly * invRadiusY;
      let coverage =
        tipKind === 3
          ? tipLevel !== null
            ? sampleTipLevel(tipLevel, u, v)
            : 0
          : sweeping
            ? sweptRoundCoverage(u, v, sweepU, sweepV, sweepR0, invRadius, invRadiusY, softness, aa)
            : proceduralCoverage(tipKind, u, v, invRadius, invRadiusY, softness, aa);
      if (coverage <= 0) continue;
      // Wet edges are a stroke-level pass (`applyStrokeWetEdges`), not
      // per stamp — per-stamp rims make concentric halos at every dab.
      if (dualActive) {
        const dlx = dxBase0 * dualCosT + dyBase0 * dualSinT;
        const dly = -dxBase0 * dualSinT + dyBase0 * dualCosT;
        const du = dlx * dualInvR;
        const dv = dly * dualInvR;
        const dCov =
          dualKind === 3
            ? dualLevel !== null
              ? sampleTipLevel(dualLevel, du, dv)
              : 0
            : dualProceduralCoverage(dualKind, du, dv, dualRadius);
        coverage *= 1 - dualMix + dualMix * dCov;
        if (coverage <= 0) continue;
      }
      if (grainEnabled) {
        const n = grainFollowsBrush
          ? grainNoise(lx, ly, grainScale)
          : grainNoise(px, py, grainScale);
        coverage = applyGrain(coverage, n, grainAmount, grainSubtract, invAlpha);
        if (coverage <= 0) continue;
      }
      if (smudge !== null) {
        const k = (stampOpacity / 100) * coverage;
        smudgePixel(layer, canvasW, canvasH, px, py, k, k, smudge, touched, sel, tiledMode, s.ditherSeed);
        continue;
      }
      if (strokeSt !== null) {
        strokePixel(strokeSt, layer, touched, sel, canvasW, canvasH, px, py, coverage, tiledMode);
        continue;
      }
      blendPixelOver(
        renderer,
        layer,
        px,
        py,
        r,
        g,
        b,
        a,
        stampOpacity * coverage,
        touched,
        sel,
        tiledW,
        tiledH,
        srcFloat,
        bypassCap,
        // Flat ceiling: flow builds up to the Opacity setting (see
        // `accumulate` in brush_stamp.cpp).
        fullFlow ? undefined : ceiling,
        s.ditherSeed,
      );
    }
  }
}

/** Compute the spline derivative — used for stroke direction at a point. */
function bezierDirection(
  p0x: number,
  p0y: number,
  cpx: number,
  cpy: number,
  p1x: number,
  p1y: number,
  t: number,
): number {
  const dx = 2 * (1 - t) * (cpx - p0x) + 2 * t * (p1x - cpx);
  const dy = 2 * (1 - t) * (cpy - p0y) + 2 * t * (p1y - cpy);
  // A degenerate tangent (control point on an endpoint — e.g. the first
  // segment's start) gave atan2(0, 0) = 0 and seeded direction-follow tips
  // at 0°. Fall back to the chord direction.
  if (Math.abs(dx) + Math.abs(dy) < 1e-9) {
    return Math.atan2(p1y - p0y, p1x - p0x);
  }
  return Math.atan2(dy, dx);
}

// Targets of captureStrokeBbox, set by emitStampWithCount for its stamps.
let bboxCaptureState: StrokeStampState | null = null;
let bboxCaptureForward:
  | ((minX: number, minY: number, maxX: number, maxY: number) => void)
  | undefined;

/** Accumulate the stroke-level bbox in `state` — `applyStrokeWetEdges` uses
 *  it to scope its scan to the stroke's actual footprint instead of the
 *  entire canvas — and forward to the caller's bbox callback. */
function captureStrokeBbox(minX: number, minY: number, maxX: number, maxY: number): void {
  const state = bboxCaptureState;
  if (state) {
    if (state.strokeBboxValid) {
      if (minX < state.strokeBboxLx) state.strokeBboxLx = minX;
      if (minY < state.strokeBboxLy) state.strokeBboxLy = minY;
      if (maxX > state.strokeBboxRx) state.strokeBboxRx = maxX;
      if (maxY > state.strokeBboxRy) state.strokeBboxRy = maxY;
    } else {
      state.strokeBboxLx = minX;
      state.strokeBboxLy = minY;
      state.strokeBboxRx = maxX;
      state.strokeBboxRy = maxY;
      state.strokeBboxValid = true;
    }
  }
  bboxCaptureForward?.(minX, minY, maxX, maxY);
}

function emitStampWithCount(
  p: StampSegmentParams,
  cx: number,
  cy: number,
  size: number,
  opacity: number,
  pose: StrokePoseInputs,
  onStampBbox: ((minX: number, minY: number, maxX: number, maxY: number) => void) | undefined,
): void {
  const { brush, renderer, layer, sampler, primary, secondary, state, selectionMask, tiledMode } = p;
  // Wrap the caller's bbox callback so we also accumulate the stroke-level
  // bbox in `state` — `applyStrokeWetEdges` uses it to scope its scan to
  // the stroke's actual footprint instead of the entire canvas.
  // (Module-level callback + targets instead of a closure per step.)
  bboxCaptureState = state;
  bboxCaptureForward = onStampBbox;

  // ─── Direction smoothing ─────────────────────────────────────────────────
  // Three failure modes to avoid:
  //   1. No smoothing → tip snap-rotates at sharp corners (visible fork).
  //   2. Pure EMA → tip lags through corners, painting transition stamps
  //      at intermediate angles while still positioned at the corner.
  //   3. Rotation during dwell → when the user pauses at a corner, multiple
  //      stamps emitted at nearly the same position rotate through the arc
  //      and reveal the brush's silhouette as a fan / horn.
  // Solution: light EMA + hard rate limit + velocity-gating. The rate
  // limit's max-step and the EMA's easing are *both* scaled by stroke
  // velocity so rotation only progresses when the brush is actually
  // moving. At a corner, velocity drops, rotation freezes, and the next
  // few stamps that DO move (along the new direction) carry the rotation
  // through naturally — under the cover of fresh stamp positions instead
  // of stacking on top of each other at the apex.
  const DIRECTION_EASING_MAX = 0.7; // ~70% of the delta applied at full speed
  const DIRECTION_MAX_STEP_MAX = Math.PI / 5; // 36° max rotation per stamp
  // Velocity gating: 0 (stationary) → no rotation, 1 (5 px/ms+) → full rate.
  // A tiny floor is kept so very slow but moving strokes still rotate eventually.
  const velocityGate = Math.max(0.05, Math.min(1, pose.velocity));
  const easing = DIRECTION_EASING_MAX * velocityGate;
  const maxStep = DIRECTION_MAX_STEP_MAX * velocityGate;
  const smoothedDir =
    state.smoothDirection === null
      ? pose.direction
      : stepDirection(state.smoothDirection, pose.direction, easing, maxStep);
  state.smoothDirection = smoothedDir;
  const smoothedPose = smoothedPoseScratch;
  smoothedPose.pressure = pose.pressure;
  smoothedPose.velocity = pose.velocity;
  smoothedPose.tilt = pose.tilt;
  smoothedPose.tiltAzimuth = pose.tiltAzimuth;
  smoothedPose.rotation = pose.rotation;
  smoothedPose.direction = smoothedDir;

  // Resolve count from the curve (jitterMul × base count, min 1).
  const inputs = makeStampInputs(smoothedPose, state, 0);
  const countMul = resolveDynamic(brush.scatter.countJitter, inputs);
  const count = Math.max(
    1,
    Math.min(16, Math.round(brush.scatter.count * countMul)),
  );

  // ─── Smudge: pick up the pixels under the dab once per spacing step ─────
  // All sub-stamps of a scatter group paint the same patch (re-picking per
  // sub-stamp would smear the group into itself).
  let smudge: SmudgeStamp | null = null;
  if (brush.smudge.enabled && layer.format !== "indexed8") {
    const pcx = Math.round(cx);
    const pcy = Math.round(cy);
    state.smudgePatch = pickUpSmudge(
      state.smudgePatch,
      layer,
      pcx,
      pcy,
      size * 0.5,
      brush.smudge.strength,
      tiledMode ? renderer.pixelWidth : undefined,
      tiledMode ? renderer.pixelHeight : undefined,
    );
    smudge = smudgeStampScratch;
    smudge.patch = state.smudgePatch;
    smudge.cx = pcx;
    smudge.cy = pcy;
    smudge.colorRate = Math.max(0, Math.min(1, brush.smudge.colorRate));
  }

  // Smudge stamps re-blend over each other (no per-stroke cap); the
  // `touched` map still records the silhouette for wet edges.
  const bypassCap = smudge !== null;

  // EMA weight for inter-stamp colour smoothing. Lower values produce
  // smoother gradients (more lag); higher values track jitter swings more
  // closely. 0.18 means each new stamp contributes ~18% of the colour
  // change, so a full transition spans ~6 stamps — about one brush-diameter
  // at default spacing — which reads as a continuous gradient instead of
  // discrete pills.
  const COLOR_EMA = 0.18;

  const sweep = count === 1 && sweepsDabs(brush, sampler);
  let lastSize = 0;
  for (let k = 0; k < count; k++) {
    const resolved = resolveStamp(
      brush,
      size,
      opacity,
      cx,
      cy,
      primary,
      secondary,
      smoothedPose,
      state,
      k,
    );
    // Swept dab: join this dab to the previous one (round tips, one dab
    // per step). A jump much longer than the spacing (a build-up tick
    // elsewhere) starts fresh instead of drawing a bridge.
    if (sweep && state.prevStampSize > 0) {
      const dx = state.prevTipX - resolved.cx;
      const dy = state.prevTipY - resolved.cy;
      const reach = Math.max(resolved.size, state.prevStampSize) * 0.6 + 1;
      if (dx * dx + dy * dy <= reach * reach) {
        resolved.sweepDx = dx;
        resolved.sweepDy = dy;
        resolved.sweepPrevSize = state.prevStampSize;
      }
    }
    lastSize = resolved.size;
    // Inter-stamp colour smoothing — applied to the jitter-resolved base
    // colour (smudge mixes this colour into its patch by colorRate).
    if (state.prevStampColor) {
      resolved.fr =
        state.prevStampColor.r * (1 - COLOR_EMA) + resolved.fr * COLOR_EMA;
      resolved.fg =
        state.prevStampColor.g * (1 - COLOR_EMA) + resolved.fg * COLOR_EMA;
      resolved.fb =
        state.prevStampColor.b * (1 - COLOR_EMA) + resolved.fb * COLOR_EMA;
      resolved.fa =
        state.prevStampColor.a * (1 - COLOR_EMA) + resolved.fa * COLOR_EMA;
    }
    const psc = state.prevStampColor ?? (state.prevStampColor = { r: 0, g: 0, b: 0, a: 0 });
    psc.r = resolved.fr;
    psc.g = resolved.fg;
    psc.b = resolved.fb;
    psc.a = resolved.fa;
    // Resolve dual-brush parameters once per stamp. Skipped when disabled
    // or zero-mix so the inner loop's pre-cached `dualSampler === null`
    // gate short-circuits cleanly.
    let dual: DualResolved | null = null;
    const dt = brush.dualTip;
    if (dt && dt.enabled && dt.mix > 0 && dt.sizeRatio > 0) {
      let baseAngle = resolved.angle + dt.angle;
      if (dt.directionFollow) baseAngle += smoothedPose.direction;
      dual = {
        sampler: getCachedTipSampler(dt.shape),
        baseAngle,
        sizeRatio: dt.sizeRatio,
        mix: Math.max(0, Math.min(1, dt.mix)),
      };
    }
    applyStamp(
      renderer,
      layer,
      brush,
      sampler,
      resolved,
      selectionMask,
      tiledMode,
      state.touched,
      bypassCap,
      captureStrokeBbox,
      dual,
      smudge,
      state.strokeLayer,
    );
  }
  state.prevTipX = cx;
  state.prevTipY = cy;
  state.prevStampSize = lastSize;
  state.arcAccum = 0;
  state.stampIndex++;
  state.isFirstStamp = false;
}

/**
 * Walk a quadratic Bézier segment and emit stamps at ~uniform arc-length
 * intervals.
 */
export function stampSegment(p: StampSegmentParams): void {
  const {
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
    state,
    onStampBbox,
    spacingOverride,
    forceFirst,
    pose0,
    pose1,
    brush,
    layer,
    sampler,
    selectionMask,
    tiledMode,
  } = p;

  const spacingPct =
    spacingOverride !== undefined ? spacingOverride : brush.tip.spacing;
  const minSize = Math.min(size0, size1);
  const stamp_dx_pixels = Math.max(0.5, (spacingPct / 100) * minSize);

  // ── Segment-level WASM batch ───────────────────────────────────────
  // When every stamp in this segment will hit the zero-copy WASM kernel
  // path, open a per-segment batch: each stamp packs its params into a
  // pre-allocated WASM-heap array and the whole segment fires as a
  // single WASM call at flush time. Eliminates the per-stamp
  // BrushStampJob allocation (and the GC pressure that came with it),
  // plus reduces JS↔WASM crossings from N to 1 per segment. Falls back
  // to per-stamp dispatch when smudge / motion-blur / tiled / indexed8 /
  // unpinned-layer are in play (any of which the kernel path skips).
  const wasmModule = getPixelOpsSync();
  // Common WASM-batch prerequisites. Both batches also need motion blur
  // effectively off (the kernels can't elongate), so a stroke never mixes
  // elongated and round stamps.
  const wasmBatchReady =
    wasmModule !== null &&
    !(state.strokeLayer !== null && state.strokeLayer.wasm === null) &&
    !brush.smudge.enabled &&
    !tiledMode &&
    layer.format !== "indexed8" &&
    layer.wasmPtr !== undefined &&
    state.touched.wasmPtr !== undefined &&
    effectiveMotionBlur(brush) === 0;
  // The bitmap batch snaps stamps to whole pixels: only for big stamps
  // whose edge is soft enough (or irregular enough — sampled tips) to hide
  // it.
  const minSegSize = Math.min(size0, size1);
  const softEnough =
    sampler.tipKind === 3 ||
    brushSoftness(brush) * minSegSize * 0.5 >= BITMAP_BATCH_MIN_FALLOFF_PX;
  const bitmapBatchable =
    wasmBatchReady &&
    minSegSize >= BITMAP_BATCH_MIN_SIZE &&
    softEnough &&
    !sweepsDabs(brush, sampler) &&
    state.strokeLayer === null &&
    isShapeStaticSegment(brush, size0, size1);

  // Bitmap tips: one density level per segment (a batch shares it), chosen
  // for the segment's mean dab size.
  const dt = brush.dualTip;
  const dualOn = !!(dt && dt.enabled && dt.mix > 0 && dt.sizeRatio > 0);
  const dualSampler = dualOn ? getCachedTipSampler(dt!.shape) : null;
  const meanSize = (size0 + size1) * 0.5;
  segmentTipLevel =
    sampler.levels !== undefined ? tipLevelFor(sampler.levels, meanSize) : null;
  segmentDualLevel =
    dualSampler?.levels !== undefined
      ? tipLevelFor(dualSampler.levels, meanSize * dt!.sizeRatio)
      : null;

  if (wasmBatchReady) {
    // ── Pre-rasterized bitmap fast path ──────────────────────────────
    // When the brush shape is identical for every stamp in the segment,
    // bake the full coverage map once and per-stamp blit it. Eliminates
    // the per-pixel tip + dual + grain compute — the bulk of the cost for
    // soft brushes, whose falloff never saturates the coverage buffer.
    let usedBitmapBatch = false;
    if (bitmapBatchable) {
      // Shape params are the same for every stamp in the segment.
      const baked = ensureBakedBitmap(wasmModule!, {
        radius: size0 * 0.5,
        roundness: Math.max(0.05, Math.min(1, brush.tip.roundness)),
        angle: brush.tip.angle,
        shear: 0,
        aa: brush.antiAlias,
        softness: brushSoftness(brush),
        flipX: 1,
        flipY: 1,
        tipKind: sampler.tipKind,
        tipData: segmentTipLevel?.data,
        tipW: segmentTipLevel?.w,
        tipH: segmentTipLevel?.h,
        dualActive: dualOn,
        dualTipKind: dualSampler?.tipKind,
        dualSizeRatio: dualOn ? dt!.sizeRatio : undefined,
        // directionFollow is required to be false for static; dual base
        // angle = primary angle + dt.angle, no per-stamp variation.
        dualBaseAngle: dualOn ? brush.tip.angle + dt!.angle : undefined,
        dualMix: dualOn ? Math.max(0, Math.min(1, dt!.mix)) : undefined,
        dualTipData: segmentDualLevel?.data,
        dualTipW: segmentDualLevel?.w,
        dualTipH: segmentDualLevel?.h,
        grainAmount: brush.texture.amount,
        grainScale: Math.max(2, brush.texture.scale),
        grainFollowBrush: brush.texture.followBrush,
        grainMode: (brush.texture.mode ?? "multiply") === "subtract" ? 1 : 0,
      });
      if (baked !== null) {
        beginBrushBatchBitmap(
          wasmModule!,
          baked.ptr,
          baked.bmW,
          baked.bmH,
          baked.halfX,
          baked.halfY,
          layer.wasmPtr!,
          state.touched.wasmPtr!,
          selectionMask ?? undefined,
        );
        brushStampBatchOpen = true;
        brushStampBatchIsBitmap = true;
        usedBitmapBatch = true;
      }
    }
    if (!usedBitmapBatch) {
      beginBrushBatch(
        wasmModule!,
        layer.wasmPtr!,
        state.touched.wasmPtr!,
        selectionMask ?? undefined,
        segmentTipLevel?.data,
        segmentTipLevel?.w ?? 0,
        segmentTipLevel?.h ?? 0,
        segmentDualLevel?.data,
        segmentDualLevel?.w ?? 0,
        segmentDualLevel?.h ?? 0,
      );
      brushStampBatchOpen = true;
    }
  }

  // try/finally: a stamp append can throw (WASM out of memory). The batch
  // flags must never stay set, or later stamps would be queued into a batch
  // that is never flushed and silently paint nothing.
  try {
    if (forceFirst && state.isFirstStamp) {
      // Segment-start stamp uses pose0 with the Bézier-tangent direction at t=0.
      const startPose = lerpPoseInto(stepPoseScratch, pose0, pose1, 0);
      startPose.direction = bezierDirection(p0x, p0y, cpx, cpy, p1x, p1y, 0);
      emitStampWithCount(p, p0x, p0y, size0, opacity0, startPose, onStampBbox);
    }

    const chord = Math.hypot(p1x - p0x, p1y - p0y);
    const polyline =
      Math.hypot(cpx - p0x, cpy - p0y) + Math.hypot(p1x - cpx, p1y - cpy);
    const approxLen = (chord + polyline) * 0.5;
    const substeps = Math.max(
      8,
      Math.ceil((approxLen / Math.max(0.5, stamp_dx_pixels)) * 4),
    );

    let prevX = p0x;
    let prevY = p0y;
    // Spacing can shrink between segments (pressure size / taper): a carry
    // larger than the new spacing gave a negative `need` and placed a stamp
    // behind the segment start.
    if (state.arcAccum > stamp_dx_pixels) state.arcAccum = stamp_dx_pixels;
    for (let i = 1; i <= substeps; i++) {
      const t = i / substeps;
      const omt = 1 - t;
      const x = omt * omt * p0x + 2 * omt * t * cpx + t * t * p1x;
      const y = omt * omt * p0y + 2 * omt * t * cpy + t * t * p1y;
      let stepLen = Math.hypot(x - prevX, y - prevY);
      let sx = prevX, sy = prevY;
      while (state.arcAccum + stepLen >= stamp_dx_pixels) {
        const need = stamp_dx_pixels - state.arcAccum;
        const f = stepLen > 0 ? need / stepLen : 0;
        const cx = sx + (x - sx) * f;
        const cy = sy + (y - sy) * f;
        const tt = t - (1 - f) * (1 / substeps);
        const ttClamped = Math.max(0, Math.min(1, tt));
        const sz = size0 + (size1 - size0) * ttClamped;
        const op = opacity0 + (opacity1 - opacity0) * ttClamped;
        const dirAtT = bezierDirection(p0x, p0y, cpx, cpy, p1x, p1y, tt);
        // Pose lerp: smoothly varies pressure/velocity/tilt/rotation along
        // the segment so dynamic curves driven by these sources don't step
        // at each pointer-event boundary.
        const stampPose = lerpPoseInto(stepPoseScratch, pose0, pose1, ttClamped);
        stampPose.direction = dirAtT;
        emitStampWithCount(p, cx, cy, sz, op, stampPose, onStampBbox);
        sx = cx;
        sy = cy;
        stepLen -= need;
      }
      state.arcAccum += stepLen;
      prevX = x;
      prevY = y;
    }
  } finally {
    segmentTipLevel = null;
    segmentDualLevel = null;
    // Fire all queued stamps for the segment in one WASM call.
    if (brushStampBatchOpen) {
      try {
        flushBrushBatch(wasmModule!);
      } finally {
        brushStampBatchOpen = false;
        brushStampBatchIsBitmap = false;
      }
    }
  }
}

/**
 * Single-stamp variant — used for the initial dot at pointer-down, and by the
 * build-up timer to emit stamps at a fixed rate while the pointer is held still.
 */
export function stampDot(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  layers: GpuLayer[],
  brush: Brush,
  sampler: TipSampler,
  cx: number,
  cy: number,
  size: number,
  opacity: number,
  primary: RGBAColor,
  secondary: RGBAColor,
  selectionMask: Uint8Array | null,
  tiledMode: boolean,
  state: StrokeStampState,
  pose: StrokePoseInputs,
  onStampBbox?: (minX: number, minY: number, maxX: number, maxY: number) => void,
): void {
  // Reuse the count loop so a single dot also respects scatter count.
  emitStampWithCount(
    {
      renderer,
      layer,
      layers,
      brush,
      sampler,
      p0x: cx,
      p0y: cy,
      cpx: cx,
      cpy: cy,
      p1x: cx,
      p1y: cy,
      size0: size,
      size1: size,
      opacity0: opacity,
      opacity1: opacity,
      primary,
      secondary,
      selectionMask,
      tiledMode,
      state,
      pose0: pose,
      pose1: pose,
    },
    cx,
    cy,
    size,
    opacity,
    pose,
    onStampBbox,
  );
  // A dot has no travel direction (its pose direction is a placeholder 0).
  // Don't let it seed the direction smoothing, or direction-follow tips
  // start every stroke rotated toward 0° and take dozens of stamps to turn.
  state.smoothDirection = null;
}

// ─── Stroke-level wet edges ─────────────────────────────────────────────────
//
// Watercolor "wet edges" should appear as a single darker rim around the
// outer silhouette of the painted stroke — *not* as a halo around every
// individual stamp. We solve this by running a single pass at the end of the
// stroke (or any time the caller wants to "commit" the wet look) that walks
// the per-stroke `touched` map (which records max effective alpha per canvas
// pixel) and finds pixels that lie within `wetWidth` of an unpainted neighbor.
// Those pixels are the stroke's outer band; we darken them in the layer by
// multiplying their RGB by `1 − amount × falloff(distance)`.
//
// Distance is approximated by sampling 8 directions at an ascending list of
// radii up to `wetWidth`. The smallest radius where any sample lands in
// uncovered territory is taken as the distance to the boundary; pixels
// beyond `wetWidth` stay untouched. Cost is O(touched × radii × 8) and runs
// once at stroke end — negligible compared to the stroke itself.

const WET_RING_DIRS: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0.7071, 0.7071],
  [-0.7071, 0.7071],
  [0.7071, -0.7071],
  [-0.7071, -0.7071],
];

// "Interior" = pixel firmly inside the stroke; we may darken it if a nearby
// neighbour is exterior. "Exterior" = pixel that's clearly outside the
// stroke; if any sampled neighbour at radius `r` is exterior we treat the
// centre as `r` away from the silhouette.
//
// The exterior threshold has to be low enough that a *soft stamp shoulder*
// (where coverage tapers to ~0.05) isn't misread as the outside, otherwise
// every soft brush gets a patchy rim because the boundary detector finds
// "exterior" pixels deep inside the stroke band.
const WET_INTERIOR_THRESHOLD = 0.35;
const WET_EXTERIOR_THRESHOLD = 0.05;

/**
 * Apply watercolor-style wet edges to the layer, using the per-stroke touched
 * mask as the stroke's silhouette. Idempotent — calling again with the same
 * touched map will continue to darken (the layer pixels store cumulative
 * darkening), so callers should call this exactly once per stroke at the end.
 */
export function applyStrokeWetEdges(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  touched: TouchedBuffer,
  brush: Brush,
  strokeBbox: { lx: number; ly: number; rx: number; ry: number } | null,
): { dirty: { lx: number; ly: number; rx: number; ry: number } | null } {
  if (!brush.wetEdges.enabled) return { dirty: null };
  const amount = Math.max(0, Math.min(1, brush.wetEdges.amount));
  if (amount <= 0) return { dirty: null };
  // Indexed8 is palette-based — multiplicative darkening doesn't make sense.
  if (layer.format === "indexed8") return { dirty: null };
  if (!strokeBbox) return { dirty: null };

  const wetWidth = Math.max(1, brush.wetEdges.width);
  const w = renderer.pixelWidth;
  const h = renderer.pixelHeight;
  const tdata = touched.data;
  // Quantised thresholds (the buffer stores 0..255 bytes now).
  const interiorByte = (WET_INTERIOR_THRESHOLD * 255 + 0.5) | 0;
  const exteriorByte = (WET_EXTERIOR_THRESHOLD * 255 + 0.5) | 0;

  // Sample at four ascending radii so we pick up the smallest distance to
  // unpainted territory with reasonable accuracy.
  const radii: number[] = [];
  const steps = 4;
  for (let i = 1; i <= steps; i++) radii.push((wetWidth * i) / steps);

  let dxLo = layer.layerWidth;
  let dyLo = layer.layerHeight;
  let dxHi = 0;
  let dyHi = 0;
  let anyDirty = false;

  // Scan only the stroke's footprint. The previous implementation iterated
  // the sparse Map's entries directly; with a flat Uint8Array we'd otherwise
  // walk the entire canvas. Clamp to canvas bounds defensively.
  const sx0 = Math.max(0, strokeBbox.lx);
  const sy0 = Math.max(0, strokeBbox.ly);
  const sx1 = Math.min(w - 1, strokeBbox.rx);
  const sy1 = Math.min(h - 1, strokeBbox.ry);

  for (let py = sy0; py <= sy1; py++) {
    const rowBase = py * w;
    for (let px = sx0; px <= sx1; px++) {
      const coverByte = tdata[rowBase + px];
      if (coverByte < interiorByte) continue;

      // Find the smallest radius at which we hit unpainted territory.
      let dist = wetWidth + 1;
      for (let ri = 0; ri < radii.length; ri++) {
        const r = radii[ri];
        let foundEdge = false;
        for (let di = 0; di < WET_RING_DIRS.length; di++) {
          const dx = WET_RING_DIRS[di][0];
          const dy = WET_RING_DIRS[di][1];
          const nx = Math.round(px + dx * r);
          const ny = Math.round(py + dy * r);
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
            foundEdge = true;
            break;
          }
          if (tdata[ny * w + nx] < exteriorByte) {
            foundEdge = true;
            break;
          }
        }
        if (foundEdge) {
          dist = r;
          break;
        }
      }
      if (dist > wetWidth) continue;

      // Smoothstep falloff: 1 (max darkening) at the silhouette → 0 at wetWidth.
      const t = 1 - dist / wetWidth;
      const falloff = t * t * (3 - 2 * t);
      const factor = 1 - amount * falloff;
      if (factor >= 0.999) continue;

      const lx = px - layer.offsetX;
      const ly = py - layer.offsetY;
      if (lx < 0 || lx >= layer.layerWidth || ly < 0 || ly >= layer.layerHeight)
        continue;

      const [er, eg, eb, ea] = renderer.samplePixel(layer, lx, ly);
      if (layer.format === "rgba32f") {
        renderer.drawPixel(layer, lx, ly, er * factor, eg * factor, eb * factor, ea);
      } else {
        // Darken in linear light like rgba32f (scaling sRGB bytes by the
        // same factor darkened far more: 0.5 → ~22% of the light).
        const dk = (v: number): number =>
          Math.round(linearToSrgbChannel(srgbToLinearChannel(v / 255) * factor) * 255);
        renderer.drawPixel(layer, lx, ly, dk(er), dk(eg), dk(eb), ea);
      }

      if (lx < dxLo) dxLo = lx;
      if (ly < dyLo) dyLo = ly;
      if (lx + 1 > dxHi) dxHi = lx + 1;
      if (ly + 1 > dyHi) dyHi = ly + 1;
      anyDirty = true;
    }
  }

  if (!anyDirty) return { dirty: null };
  return { dirty: { lx: dxLo, ly: dyLo, rx: dxHi, ry: dyHi } };
}
