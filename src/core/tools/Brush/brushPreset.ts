/**
 * Painter-grade brush data model.
 *
 * A `Brush` is a complete brush preset: tip shape, spacing, dynamics, color
 * dynamics, pose, noise, wet edges, build up and smoothing. Every per-stamp
 * value that can vary across a stroke is expressed as a `DynamicCurve` so
 * the panel UI is uniform and the engine can resolve any of them the same
 * way.
 *
 * Brushes live in two places, mirroring the pixel-brush model:
 *  - **Document brushes** travel with the .verve file (AppState.brushes).
 *  - **User brushes** live in electron userData/paint-brushes.json and are
 *    available across documents (brushStore singleton).
 */

// ─── Shape ────────────────────────────────────────────────────────────────────

/**
 * Procedural primitive — analytical SDF, scales to any size with no artifacts.
 * `bitmap` is filled in by PR2 (SDF computed from a captured pixel selection).
 */
export type BrushTipKind = "round" | "square" | "diamond" | "bitmap";

export interface BrushTipShape {
  kind: BrushTipKind;
  /** For `bitmap` tips: source RGBA, base64, width × height × 4. PR1 stores raw alpha; PR2 adds SDF. */
  bitmapRgba?: string;
  bitmapWidth?: number;
  bitmapHeight?: number;
  /**
   * SDF of the tip alpha, normalized so 0 = edge, negative = inside, positive = outside.
   * Stored as Float32 base64. Filled in by PR2; absent in PR1.
   */
  sdfBase64?: string;
  sdfWidth?: number;
  sdfHeight?: number;
}

// ─── Dynamic curves ──────────────────────────────────────────────────────────

/**
 * What drives a per-stamp dynamic. `pressure`/`tilt` come from pen events
 * (mouse falls back to constant 0.5 / 0). `velocity` is px/ms normalised by
 * the brush engine. `direction` is stroke heading (0..1 around the circle).
 * `fade` ramps from 1 → 0 over a configurable count of stamps. `random` uses
 * a deterministic per-stamp hash so previews are stable.
 */
export type DynamicSource =
  | "off"
  | "pressure"
  | "velocity"
  | "tilt"
  | "direction"
  | "rotation"
  | "random"
  | "fade";

/**
 * Curve editor data: an array of (x, y) control points in [0, 1]² describing
 * the response curve from input source to output. The engine evaluates the
 * curve as a monotone Catmull–Rom spline. Two endpoints (0,0) and (1,1) are
 * the identity curve.
 */
export interface DynamicCurve {
  /** 0..1 — how much the source can affect the value. 0 disables the dynamic entirely. */
  jitter: number;
  /** What drives this dynamic. `off` = constant base value, no modulation. */
  source: DynamicSource;
  /** Floor of the modulated output, 0..1 of base value. */
  minimum: number;
  /** Catmull–Rom control points sorted by x; both x and y are in [0,1]. */
  curve: { x: number; y: number }[];
  /** When `source === 'fade'`, number of stamps over which to ramp from 1 → minimum. */
  fadeStamps?: number;
}

// ─── Setting groups ──────────────────────────────────────────────────────────

export interface TipSettings {
  /** Diameter in canvas pixels. */
  size: number;
  /** 0..100 — % of tip diameter between consecutive stamps. */
  spacing: number;
  /** 0..100 — edge softness; 100 = hard. */
  hardness: number;
  /** 0..1 — non-circular tip flattening (1 = circle, 0.1 = near-line). */
  roundness: number;
  /** Tip rotation in radians (constant; ShapeDynamics adds modulation). */
  angle: number;
  /** Mirror tip horizontally / vertically each stamp (Photoshop "Flip X/Y Jitter"). */
  flipXJitter: number; // 0..1 probability
  flipYJitter: number;
  /**
   * 0..100 — paint deposited per stamp, separate from `opacity`.
   *
   * `opacity` is the per-stroke ceiling at any pixel; `flow` is how much
   * paint each individual stamp lays down toward that ceiling. With
   * flow=100, each stamp reaches the ceiling on first contact (the engine's
   * legacy behaviour). With flow<100, overlapping stamps build up gradually
   * — the soft "paintable" feel of a real brush. Photoshop, Krita, Procreate
   * all expose this as a top-level brush setting.
   *
   * Older saved brushes without this field are treated as flow=100.
   */
  flow: number;
}

export interface ScatterDynamics {
  /** 0..N — radius (in tip-diameters) of position scatter around the spline. */
  amount: number;
  /** Modulates `amount`. */
  jitter: DynamicCurve;
  /** Scatter on both axes (true) or only perpendicular to stroke (false). */
  bothAxes: boolean;
  /** Stamps per spacing-step (>=1). */
  count: number;
  countJitter: DynamicCurve;
}

export interface ShapeDynamics {
  sizeJitter: DynamicCurve;
  angleJitter: DynamicCurve;
  roundnessJitter: DynamicCurve;
}

export interface ColorDynamics {
  /** Probability of swapping fg/bg per stamp. */
  fgBgJitter: DynamicCurve;
  hueJitter: DynamicCurve; // ±180° at jitter=1
  saturationJitter: DynamicCurve;
  brightnessJitter: DynamicCurve;
  purityJitter: DynamicCurve; // pulls toward gray
  /** When true, color dynamics are applied per-stamp; when false, once per stroke. */
  perStamp: boolean;
}

export interface PoseDynamics {
  /** Use pen tilt to skew the tip (perspective fake). 0..1. */
  tiltScale: number;
  /** Use pen rotation (barrel) to rotate the tip. Overrides angle entirely. */
  rotationFollow: boolean;
  /** Rotate the tip to follow the stroke direction. `tip.angle` becomes the
   *  baseline offset relative to "north along the stroke" — useful for
   *  ribbon / calligraphy brushes whose orientation should track the path. */
  directionFollow: boolean;
  /** Pen pressure → squash/stretch. 0..1. */
  pressureSquash: number;
}

export interface NoiseSettings {
  /** 0..1 — how much per-pixel noise modulates the tip alpha. */
  amount: number;
  /** Spatial frequency of noise in canvas pixels. */
  scale: number;
}

export interface WetEdgeSettings {
  enabled: boolean;
  /** 0..1 — edge darkening intensity. */
  amount: number;
  /** Pixels of edge band where darkening applies. */
  width: number;
}

/**
 * Build-up: "airbrush" mode. When true, holding the pointer in one place keeps
 * adding paint; when false, a single stamp's contribution is capped per stroke
 * (the existing `touched` map already implements this — PR1 just exposes it).
 */
export interface BuildUpSettings {
  enabled: boolean;
  /** Stamps per second when held still and enabled. */
  rate: number;
}

/**
 * Smudge: each stamp samples the colour under the brush and drags it forward
 * along the stroke instead of (or in addition to) laying down fresh paint.
 *
 * - `strength` controls "tail length" — at 1 the carried color persists
 *   indefinitely, at 0 each stamp picks up purely the local layer color.
 * - `colorRate` mixes in the foreground colour. 0 = pure smudge (Photoshop's
 *   classic Smudge tool), 1 = pure paint (no smudge), values in between are
 *   "finger painting".
 *
 * When enabled, the engine bypasses the per-stroke `touched` cap so each
 * stamp can re-blend over previous ones — without that, smudge can't
 * progress along the stroke.
 */
export interface SmudgeSettings {
  enabled: boolean;
  strength: number; // 0..1
  colorRate: number; // 0..1
}

export interface SmoothingSettings {
  /** 0..100 — EMA stabiliser strength (already implemented). */
  ema: number;
  /** 0..1 — pull-string distance (cursor lags by `pullString × diameter`). */
  pullString: number;
  /** Catch-up: when stroke ends, render remaining lag. */
  catchUp: boolean;
}

export interface PaperTexture {
  /** Optional grain texture base64 (RGBA tile, repeated). */
  tileRgba?: string;
  tileWidth?: number;
  tileHeight?: number;
  /** 0..1 — grain contribution. */
  amount: number;
  /** Pixels per tile repeat. */
  scale: number;
  /** When true, grain follows the brush; when false, it's locked to the canvas. */
  followBrush: boolean;
}

// ─── Top-level brush ─────────────────────────────────────────────────────────

export type BrushScope = "document" | "user";

export interface Brush {
  id: string;
  name: string;
  /** "document" or "user" — informational; the actual storage location is the source of truth. */
  scope: BrushScope;
  createdAt: number;
  shape: BrushTipShape;
  tip: TipSettings;
  scatter: ScatterDynamics;
  shapeDyn: ShapeDynamics;
  colorDyn: ColorDynamics;
  pose: PoseDynamics;
  noise: NoiseSettings;
  texture: PaperTexture;
  wetEdges: WetEdgeSettings;
  buildUp: BuildUpSettings;
  smudge: SmudgeSettings;
  smoothing: SmoothingSettings;
  /** Tip uniform alpha multiplier (0..100). Maps to existing `opacity`. */
  opacity: number;
  /** When true, soft anti-aliased edges. Mirrors current `antiAlias`. */
  antiAlias: boolean;
  /** Stamp elongation along stroke direction (0..1). Mirrors current `motionBlur`. */
  motionBlur: number;
  /** Velocity-driven size/opacity falloff (preserves current behavior). */
  velocityTracking: boolean;
  /** Pen pressure scales size (preserves current behavior). */
  pressureSize: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export function identityCurve(): DynamicCurve {
  return {
    jitter: 0,
    source: "off",
    minimum: 0,
    curve: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
  };
}

/** A neutral round brush that reproduces the current default behavior. */
export function makeDefaultBrush(id: string, name = "Default"): Brush {
  return {
    id,
    name,
    scope: "user",
    createdAt: Date.now(),
    shape: { kind: "round" },
    tip: {
      size: 20,
      // Tighter spacing + softer edge produces a continuous-looking line by
      // default. Users who want crisp pixel-art style stamps can dial both up.
      spacing: 12,
      hardness: 80,
      roundness: 1,
      angle: 0,
      flipXJitter: 0,
      flipYJitter: 0,
      flow: 100,
    },
    scatter: {
      amount: 0,
      jitter: identityCurve(),
      bothAxes: true,
      count: 1,
      countJitter: identityCurve(),
    },
    shapeDyn: {
      sizeJitter: identityCurve(),
      angleJitter: identityCurve(),
      roundnessJitter: identityCurve(),
    },
    colorDyn: {
      fgBgJitter: identityCurve(),
      hueJitter: identityCurve(),
      saturationJitter: identityCurve(),
      brightnessJitter: identityCurve(),
      purityJitter: identityCurve(),
      perStamp: true,
    },
    pose: {
      tiltScale: 0,
      rotationFollow: false,
      directionFollow: false,
      pressureSquash: 0,
    },
    noise: { amount: 0, scale: 4 },
    texture: { amount: 0, scale: 64, followBrush: false },
    wetEdges: { enabled: false, amount: 0.5, width: 2 },
    buildUp: { enabled: false, rate: 30 },
    smudge: { enabled: false, strength: 0.6, colorRate: 0 },
    smoothing: { ema: 50, pullString: 0, catchUp: true },
    opacity: 100,
    antiAlias: true,
    motionBlur: 5,
    velocityTracking: true,
    pressureSize: false,
  };
}
