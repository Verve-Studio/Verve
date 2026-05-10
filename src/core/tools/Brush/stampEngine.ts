/**
 * Photoshop-style stamp-along-spline brush engine.
 *
 * The painter splits the input pointer trail into quadratic Bézier segments
 * (built upstream by the existing midpoint B-spline stabiliser in
 * `brush.tsx`) and feeds each one to `stampSegment`. The engine walks the
 * segment by ~equal arc-length steps of `spacing × radius` and applies one
 * stamp per step (or `count` stamps if scatter count > 1). Each stamp
 * samples the tip's SDF in its bounding box and composites the resulting
 * alpha into the layer via `blendPixelOver`, which already handles all
 * three pixel formats, the selection mask, tiled-mode wrapping, the
 * per-stroke `touched` coverage map and HDR srcFloat.
 *
 * PR3 wires in:
 *   • All `DynamicCurve` modulation per stamp (size/angle/roundness/scatter
 *     /count/fg-bg/hue/sat/bright/purity, with sources pressure/velocity/
 *     tilt/rotation/direction/random/fade)
 *   • Scatter (perpendicular and both-axis offsets) + multi-stamp `count`
 *   • Tip flip-X / flip-Y jitter
 *   • Pose dynamics — pen tilt skew, pen-rotation follow, pressure squash
 *   • Wet edges — interior coverage attenuation that biases paint toward the
 *     silhouette, mimicking watercolor edge pooling
 *   • Paper-grain texture — per-pixel multiplicative modulation of coverage
 *     using value noise sampled either in canvas or tip-local space
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
import { blendPixelOver } from "../_shared/primitives";
import { srgbToLinearChannel } from "@/utils/pixelFormatConvert";
import type { TipSampler } from "./tipSampler";
import type { Brush, RGBAColor } from "@/types";
import {
  resolveDynamic,
  resolveSymmetric,
  shouldFlip,
  smoothNoise1D,
  stampHash,
  type StampInputs,
} from "./dynamicsResolver";
import { resolveStampColor } from "./colorJitter";
import { sampleGrain } from "./paperTexture";

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
  /** Per-stroke touched map prevents opacity accumulation within one stroke. */
  touched: Map<number, number>;
  /** True until the first stamp has been laid down. */
  isFirstStamp: boolean;
  /**
   * Stroke-level resolved color. Computed once at stroke start and reused
   * unless `colorDyn.perStamp` is true.
   */
  strokeColor: { r: number; g: number; b: number; a: number };
  /**
   * Carried color for smudge mode — the layer color the brush is dragging
   * forward. Updated each stamp as `strength × prev + (1 − strength) × under`.
   * Null until the first stamp samples the layer.
   */
  smudgeColor: { r: number; g: number; b: number; a: number } | null;
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
}

export function makeStrokeStampState(
  primary: RGBAColor,
  seed?: number,
): StrokeStampState {
  return {
    strokeSeed: seed ?? Math.floor(Math.random() * 0xffffffff),
    stampIndex: 0,
    arcAccum: 0,
    prevTipX: 0,
    prevTipY: 0,
    touched: new Map(),
    isFirstStamp: true,
    strokeColor: {
      r: primary.r,
      g: primary.g,
      b: primary.b,
      a: primary.a,
    },
    smudgeColor: null,
    smoothDirection: null,
    prevStampColor: null,
  };
}

/** Wrap an angle delta to (−π, π]. */
function wrapPi(d: number): number {
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

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

/**
 * Read a single layer pixel and normalise to floats in [0, 1+]. Returns null
 * for indexed layers (palette-based, no meaningful smudge), and a fully
 * transparent value for out-of-layer reads (so smudging off the edge fades).
 */
function sampleOneLayerFloat(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  px: number,
  py: number,
): { r: number; g: number; b: number; a: number } | null {
  if (layer.format === "indexed8") return null;
  const lx = Math.floor(px) - layer.offsetX;
  const ly = Math.floor(py) - layer.offsetY;
  if (lx < 0 || lx >= layer.layerWidth || ly < 0 || ly >= layer.layerHeight) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const [r, g, b, a] = renderer.samplePixel(layer, lx, ly);
  if (layer.format === "rgba8") {
    return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
  }
  return { r, g, b, a };
}

/**
 * Smudge pickup samples a small cross of layer pixels around the stamp
 * centre and averages them. Single-pixel sampling at the stamp centre is
 * unstable — even a 1-px shift across an anti-aliased boundary makes the
 * carried color (and therefore the painted alpha) jitter, producing visible
 * banding along the stroke. A 5-tap cross at quarter-radius offsets covers
 * the dominant area under the brush at ~5× the stability cost of one read,
 * which is dwarfed by the inner pixel loop.
 */
function sampleSmudgeColor(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  cx: number,
  cy: number,
  size: number,
): { r: number; g: number; b: number; a: number } | null {
  if (layer.format === "indexed8") return null;
  const off = Math.max(1, size * 0.25);
  const taps: Array<[number, number]> = [
    [0, 0],
    [off, 0],
    [-off, 0],
    [0, off],
    [0, -off],
  ];
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (const [dx, dy] of taps) {
    const c = sampleOneLayerFloat(renderer, layer, cx + dx, cy + dy);
    if (!c) continue;
    r += c.r; g += c.g; b += c.b; a += c.a;
    n++;
  }
  if (n === 0) return null;
  return { r: r / n, g: g / n, b: b / n, a: a / n };
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
  opacity: number; // 0..100
  /** Resolved RGBA — float [0, 1+] for HDR. */
  fr: number;
  fg: number;
  fb: number;
  fa: number;
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
  /** Per-stroke pose inputs (latest snapshot). */
  pose: StrokePoseInputs;
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

/** Float color → 0..255 RGBA bytes for blendPixelOver's non-HDR path. */
function floatToBytes(
  fr: number,
  fg: number,
  fb: number,
  fa: number,
): { r: number; g: number; b: number; a: number } {
  return {
    r: Math.round(Math.min(fr, 1) * 255),
    g: Math.round(Math.min(fg, 1) * 255),
    b: Math.round(Math.min(fb, 1) * 255),
    a: Math.round(Math.min(Math.max(fa, 0), 1) * 255),
  };
}

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
    direction: pose.direction / (2 * Math.PI),
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
    const rh = stampHash(state.strokeSeed ^ 0xdeadbeef, state.stampIndex);
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

  // ─── Opacity ─────────────────────────────────────────────────────────────
  // Base brush opacity from the panel + per-stamp velocity/pressure already
  // baked into baseOpacity; no separate "opacity jitter" curve in the data
  // model so we leave it as-is.
  const opacity = Math.max(0, Math.min(100, baseOpacity));

  // ─── Color ───────────────────────────────────────────────────────────────
  let fr: number, fg: number, fb: number, fa: number;
  if (brush.colorDyn.perStamp) {
    const resolved = resolveStampColor(primary, secondary, brush.colorDyn, inputs);
    fr = resolved.r;
    fg = resolved.g;
    fb = resolved.b;
    fa = resolved.a;
  } else {
    fr = state.strokeColor.r;
    fg = state.strokeColor.g;
    fb = state.strokeColor.b;
    fa = state.strokeColor.a;
  }

  // ─── Motion-blur elongation along stroke direction ──────────────────────
  // brush.motionBlur is 0..100. 0 → no elongation; 100 → 4× along-stroke
  // stretch, producing a clearly smeared / calligraphic feel. Skipped at
  // very low velocities so a slow paint doesn't get an unwanted streak.
  let motionElongation = 1;
  if (brush.motionBlur > 0 && pose.velocity > 0.01) {
    const k = brush.motionBlur / 100;
    motionElongation = 1 + k * 3;
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
    fr,
    fg,
    fb,
    fa,
  };
}

/**
 * Apply one fully-resolved stamp at (cx, cy). Iterates the stamp's
 * canvas-space bounding box, samples the tip SDF, applies wet-edge
 * attenuation and paper-grain modulation to the coverage, then forwards
 * each pixel to `blendPixelOver`.
 */
function applyStamp(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  brush: Brush,
  sampler: TipSampler,
  s: ResolvedStamp,
  selectionMask: Uint8Array | null,
  tiledMode: boolean,
  touched: Map<number, number>,
  /** When true, consecutive stamps re-blend over each other (smudge / build-up
   *  ticks). The `touched` map is still updated, so wet edges still work. */
  bypassCap: boolean,
  onStampBbox: ((minX: number, minY: number, maxX: number, maxY: number) => void) | undefined,
): void {
  const radius = s.size * 0.5;
  if (radius < 0.5) return;
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
  const hardness = Math.max(0, Math.min(100, brush.tip.hardness));
  const aaWidth = brush.antiAlias
    ? Math.max(0.5, (1 - hardness / 100) * radius * 0.5 + 0.5)
    : 0;
  const cosT = Math.cos(angle);
  const sinT = Math.sin(angle);
  // Motion blur stretches the stamp along the stroke direction. The bbox
  // grows accordingly so we don't clip the smear; we use the conservative
  // axis-aligned bbox that contains a rotated ellipse with semi-axes
  // (radius × motionElongation, radius).
  const cosD = Math.cos(motionDir);
  const sinD = Math.sin(motionDir);
  const halfX = Math.ceil(
    Math.abs(cosD) * radius * motionElongation + Math.abs(sinD) * radius + aaWidth + 1,
  );
  const halfY = Math.ceil(
    Math.abs(sinD) * radius * motionElongation + Math.abs(cosD) * radius + aaWidth + 1,
  );
  const minX = Math.floor(cx - halfX);
  const maxX = Math.ceil(cx + halfX);
  const minY = Math.floor(cy - halfY);
  const maxY = Math.ceil(cy + halfY);

  if (onStampBbox) onStampBbox(minX, minY, maxX, maxY);

  const sel: SelMask | undefined =
    selectionMask !== null
      ? { mask: selectionMask, width: renderer.pixelWidth }
      : undefined;
  const tiledW = tiledMode ? renderer.pixelWidth : undefined;
  const tiledH = tiledMode ? renderer.pixelHeight : undefined;

  const invRadius = 1 / radius;
  const invRadiusY = 1 / (radius * roundness);

  if (!tiledMode) {
    if (
      maxX < 0 ||
      maxY < 0 ||
      minX >= renderer.pixelWidth ||
      minY >= renderer.pixelHeight
    )
      return;
  }

  // Pre-resolve byte color and float color for blendPixelOver.
  const { r, g, b, a } = floatToBytes(s.fr, s.fg, s.fb, s.fa);
  // Stamp colour `s.fr/fg/fb` is sRGB-encoded (it descends from primaryColor
  // with per-stamp jitter applied). For an rgba32f layer we must gamma-decode
  // before passing to blendPixelOver — the layer stores linear-light values.
  const srcFloat: readonly [number, number, number, number] | undefined =
    layer.format === "rgba32f"
      ? [
          srgbToLinearChannel(s.fr),
          srgbToLinearChannel(s.fg),
          srgbToLinearChannel(s.fb),
          s.fa,
        ]
      : undefined;

  // Paper grain — pre-cache enabled flag.
  const grainAmount = brush.texture.amount;
  const grainScale = Math.max(2, brush.texture.scale);
  const grainEnabled = grainAmount > 0;
  const grainFollowsBrush = brush.texture.followBrush;

  // Pre-compute the inverse motion-blur transform: rotate into the
  // stroke-aligned frame, compress along-stroke by 1/elongation, rotate back.
  // When motionElongation === 1 this collapses to the identity and we skip it.
  const motionActive = motionElongation > 1.0001;
  const invElong = motionActive ? 1 / motionElongation : 1;

  for (let py = minY; py <= maxY; py++) {
    const dyBase0 = py - cy;
    for (let px = minX; px <= maxX; px++) {
      const dxBase0 = px - cx;
      // Motion-blur inverse transform — converts canvas-space delta into the
      // "unsmeared" reference frame the SDF expects. Outside the smeared
      // ellipse, the resulting (dx, dy) is far from the tip centre and the
      // SDF returns positive (out of range), causing an early continue.
      let dxBase = dxBase0;
      let dyBase = dyBase0;
      if (motionActive) {
        const along = dxBase0 * cosD + dyBase0 * sinD;
        const cross = -dxBase0 * sinD + dyBase0 * cosD;
        const alongShrunk = along * invElong;
        dxBase = alongShrunk * cosD - cross * sinD;
        dyBase = alongShrunk * sinD + cross * cosD;
      }
      // Inverse rotation into tip-local axes
      let lx = dxBase * cosT + dyBase * sinT;
      let ly = -dxBase * sinT + dyBase * cosT;
      // Tilt-driven shear in tip-local x along y
      lx -= shear * ly;
      // Apply flip in tip-local space (flip is ±1 — multiplying preserves dist)
      lx *= flipX;
      ly *= flipY;
      // Map to unit space
      const u = lx * invRadius;
      const v = ly * invRadiusY;
      // SDF in unit space → multiply by radius for pixel-scale distance
      const dist = sampler.sample(u, v) * radius;
      // Convert distance → coverage (0..1)
      let coverage: number;
      if (aaWidth > 0) {
        const t = (aaWidth - dist) / (2 * aaWidth);
        if (t <= 0) continue;
        if (t >= 1) coverage = 1;
        else coverage = t * t * (3 - 2 * t);
      } else {
        if (dist > 0) continue;
        coverage = 1;
      }
      // Wet edges are NOT applied per-stamp — that produces concentric halos
      // at every dab, not a watercolor rim around the whole stroke. The
      // stroke-level pass `applyStrokeWetEdges` runs once on pointer-up and
      // darkens only the outer silhouette of the accumulated `touched` mask.
      // Paper grain — sampled either in canvas or tip-local coords.
      if (grainEnabled) {
        const gx = grainFollowsBrush ? lx : px;
        const gy = grainFollowsBrush ? ly : py;
        coverage *= sampleGrain(gx, gy, grainAmount, grainScale);
      }
      if (coverage <= 0) continue;
      blendPixelOver(
        renderer,
        layer,
        px,
        py,
        r,
        g,
        b,
        a,
        s.opacity * coverage,
        touched,
        sel,
        tiledW,
        tiledH,
        srcFloat,
        bypassCap,
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
  return Math.atan2(dy, dx);
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
  const smoothedPose: StrokePoseInputs = { ...pose, direction: smoothedDir };

  // Resolve count from the curve (jitterMul × base count, min 1).
  const inputs = makeStampInputs(smoothedPose, state, 0);
  const countMul = resolveDynamic(brush.scatter.countJitter, inputs);
  const count = Math.max(
    1,
    Math.min(16, Math.round(brush.scatter.count * countMul)),
  );

  // ─── Smudge: sample the layer once per spacing step ──────────────────────
  // The carried color is the brush's "wet pickup". We update it before any
  // sub-stamps fire so all of them in a scatter group share the same colour
  // (otherwise a high-count smudge would smear different colours into each
  // other within a single dab, which doesn't read as smudge).
  let smudgeMix: { r: number; g: number; b: number; a: number } | null = null;
  if (brush.smudge.enabled && layer.format !== "indexed8") {
    const under = sampleSmudgeColor(renderer, layer, cx, cy, size);
    if (under) {
      const k = Math.max(0, Math.min(1, brush.smudge.strength));
      const prev = state.smudgeColor;
      const next = prev
        ? {
            r: k * prev.r + (1 - k) * under.r,
            g: k * prev.g + (1 - k) * under.g,
            b: k * prev.b + (1 - k) * under.b,
            a: k * prev.a + (1 - k) * under.a,
          }
        : { ...under };
      state.smudgeColor = next;
      smudgeMix = next;
    }
  }

  // In smudge mode the per-stroke alpha cap is bypassed so consecutive
  // stamps can re-blend over each other. The `touched` map is still
  // updated though — wet edges read it as the stroke silhouette and need
  // to see every painted pixel regardless of mode.
  const bypassCap = brush.smudge.enabled;
  const colorRate = Math.max(0, Math.min(1, brush.smudge.colorRate));

  // EMA weight for inter-stamp colour smoothing. Lower values produce
  // smoother gradients (more lag); higher values track jitter swings more
  // closely. 0.18 means each new stamp contributes ~18% of the colour
  // change, so a full transition spans ~6 stamps — about one brush-diameter
  // at default spacing — which reads as a continuous gradient instead of
  // discrete pills.
  const COLOR_EMA = 0.18;

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
    // Inter-stamp colour smoothing — applied to the jitter-resolved base
    // colour. Smudge has its own carry-color path (state.smudgeColor) so
    // we deliberately smooth before the smudge override, not after.
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
    state.prevStampColor = {
      r: resolved.fr,
      g: resolved.fg,
      b: resolved.fb,
      a: resolved.fa,
    };
    if (smudgeMix) {
      // Mix carried color with the (possibly jittered) brush colour by
      // colorRate. 0 → pure smudge, 1 → pure paint, in-between is "finger
      // painting" — drag existing pixels while leaking some fresh pigment.
      resolved.fr = (1 - colorRate) * smudgeMix.r + colorRate * resolved.fr;
      resolved.fg = (1 - colorRate) * smudgeMix.g + colorRate * resolved.fg;
      resolved.fb = (1 - colorRate) * smudgeMix.b + colorRate * resolved.fb;
      resolved.fa = (1 - colorRate) * smudgeMix.a + colorRate * resolved.fa;
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
      onStampBbox,
    );
  }
  state.prevTipX = cx;
  state.prevTipY = cy;
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
    pose,
    brush,
  } = p;

  const spacingPct =
    spacingOverride !== undefined ? spacingOverride : brush.tip.spacing;
  const minSize = Math.min(size0, size1);
  const stamp_dx_pixels = Math.max(0.5, (spacingPct / 100) * minSize);

  // Shared per-segment pose snapshot — direction is segment-local.
  const baseDirection = bezierDirection(p0x, p0y, cpx, cpy, p1x, p1y, 0.5);
  const localPose: StrokePoseInputs = {
    ...pose,
    direction: baseDirection,
  };

  if (forceFirst && state.isFirstStamp) {
    emitStampWithCount(p, p0x, p0y, size0, opacity0, localPose, onStampBbox);
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
      const sz = size0 + (size1 - size0) * Math.max(0, Math.min(1, tt));
      const op = opacity0 + (opacity1 - opacity0) * Math.max(0, Math.min(1, tt));
      const dirAtT = bezierDirection(p0x, p0y, cpx, cpy, p1x, p1y, tt);
      emitStampWithCount(
        p,
        cx,
        cy,
        sz,
        op,
        { ...localPose, direction: dirAtT },
        onStampBbox,
      );
      sx = cx;
      sy = cy;
      stepLen -= need;
    }
    state.arcAccum += stepLen;
    prevX = x;
    prevY = y;
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
      pose,
    },
    cx,
    cy,
    size,
    opacity,
    pose,
    onStampBbox,
  );
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
  touched: Map<number, number>,
  brush: Brush,
): { dirty: { lx: number; ly: number; rx: number; ry: number } | null } {
  if (!brush.wetEdges.enabled) return { dirty: null };
  const amount = Math.max(0, Math.min(1, brush.wetEdges.amount));
  if (amount <= 0) return { dirty: null };
  // Indexed8 is palette-based — multiplicative darkening doesn't make sense.
  if (layer.format === "indexed8") return { dirty: null };

  const wetWidth = Math.max(1, brush.wetEdges.width);
  const w = renderer.pixelWidth;
  const h = renderer.pixelHeight;

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

  for (const [pixelKey, coverage] of touched) {
    if (coverage < WET_INTERIOR_THRESHOLD) continue;
    const px = pixelKey % w;
    const py = (pixelKey - px) / w;

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
        const ncov = touched.get(ny * w + nx) ?? 0;
        if (ncov < WET_EXTERIOR_THRESHOLD) {
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
      renderer.drawPixel(
        layer,
        lx,
        ly,
        Math.round(er * factor),
        Math.round(eg * factor),
        Math.round(eb * factor),
        ea,
      );
    }

    if (lx < dxLo) dxLo = lx;
    if (ly < dyLo) dyLo = ly;
    if (lx + 1 > dxHi) dxHi = lx + 1;
    if (ly + 1 > dyHi) dyHi = ly + 1;
    anyDirty = true;
  }

  if (!anyDirty) return { dirty: null };
  return { dirty: { lx: dxLo, ly: dyLo, rx: dxHi, ry: dyHi } };
}
