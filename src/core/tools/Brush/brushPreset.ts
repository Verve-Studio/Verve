/**
 * Painter-grade brush data model.
 *
 * A `Brush` is a complete brush preset: tip shape, spacing, dynamics, color
 * dynamics, pose, noise, wet edges, build up and smoothing. Every per-stamp
 * value that can vary across a stroke is expressed as a `DynamicCurve` so
 * the panel UI is uniform and the engine can resolve any of them the same
 * way.
 *
 * Brushes live in two places:
 *  - **Document brushes** live on AppState.brushes and travel with the
 *    .verve file (with the active brush id).
 *  - **User brushes** live in electron userData/paint-brushes.json and are
 *    available across documents (brushStore singleton).
 */

import { base64ToBytes, bytesToBase64 } from "@/utils/base64";

// ─── Shape ────────────────────────────────────────────────────────────────────

/**
 * Procedural primitive — analytical SDF, scales to any size with no artifacts.
 * `bitmap` is a sampled tip captured from pixels (Photoshop's "sampled brush").
 */
export type BrushTipKind = "round" | "square" | "diamond" | "bitmap";

export interface BrushTipShape {
  kind: BrushTipKind;
  /** For `bitmap` tips: source RGBA bytes, width × height × 4. The stamp
   *  engine samples a mip-mapped paint-density map derived from it (alpha,
   *  or darkness for an opaque capture) on first use and cached per shape
   *  (`getCachedTipSampler`), so the tip keeps its internal texture. */
  bitmapRgba?: Uint8Array;
  bitmapWidth?: number;
  bitmapHeight?: number;
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
  /** 0..100 — size of the fully opaque core as % of the radius; the rest of
   *  the radius fades out. 100 = hard (1 px anti-aliased edge). Ignored by
   *  bitmap tips, whose density map defines their edge. */
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

/**
 * Photoshop's "Transfer": per-stamp modulation of how much paint goes down.
 * `opacityJitter` scales the stroke's opacity ceiling (pen pressure → a
 * lighter or darker line); `flowJitter` scales the per-stamp deposit (pen
 * pressure → how fast paint builds up). Older brushes lack the group; the
 * engine treats `undefined` as both off.
 */
export interface TransferDynamics {
  opacityJitter: DynamicCurve;
  flowJitter: DynamicCurve;
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

/**
 * How paper grain meets the paint:
 *  - `multiply` darkens the coverage in the paper's valleys (soft, even grain).
 *  - `subtract` lifts the paint off the valleys by a fixed tooth depth, so
 *    faint paint (low opacity / pressure, soft tip edges) only catches the
 *    peaks while heavy paint fills the paper — the pencil / charcoal look.
 */
export type PaperTextureMode = "multiply" | "subtract";

export interface PaperTexture {
  /** 0..1 — grain contribution (tooth depth). */
  amount: number;
  /** Pixels per tile repeat. */
  scale: number;
  /** When true, grain follows the brush; when false, it's locked to the canvas. */
  followBrush: boolean;
  /** Older brushes lack it: `multiply`. */
  mode?: PaperTextureMode;
  /** Modulates `amount` per stamp (e.g. pen pressure → shallower tooth).
   *  Older brushes lack it: off. */
  depthJitter?: DynamicCurve;
}

/**
 * Photoshop-style "Dual Brush": a second tip whose alpha is multiplied
 * into the primary tip's alpha per pixel, breaking up the silhouette to
 * mimic dry-media (charcoal, conte, sponge, oil bristle).
 *
 * Differs from `PaperTexture` (canvas-locked grain) in two ways:
 *  - The dual tip travels with the brush — it lives in tip-local space, so
 *    the texture warps and rotates with the stamp instead of feeling
 *    glued to the canvas.
 *  - It can use any `BrushTipShape` (procedural or captured bitmap),
 *    making it a mini-brush rather than a tile pattern.
 *
 * Each primary stamp gets one dual sample (no inner stamping). The dual
 * tip is centred on the primary, scaled by `sizeRatio`, rotated by
 * `angle`, and sampled per pixel. With `mix=0` the dual contributes
 * nothing; with `mix=1` it fully gates the primary alpha.
 *
 * Older brushes lacking this field fall back to a disabled default — the
 * engine treats `dualTip === undefined` as identity multiplier.
 */
export interface DualTipSettings {
  enabled: boolean;
  shape: BrushTipShape;
  /** 0.05..2 — dual tip diameter as a fraction of primary tip diameter. */
  sizeRatio: number;
  /** Radians. Constant offset from the primary stamp's angle. */
  angle: number;
  /** 0..1 — strength of the dual mask. 0 = primary only, 1 = full multiply. */
  mix: number;
  /** When true, dual tip rotates with stroke direction (like primary's
   *  `pose.directionFollow`). Otherwise it uses `angle` only. */
  directionFollow: boolean;
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
  /** Older brushes lack this group; the engine treats `undefined` as off. */
  transfer?: TransferDynamics;
  colorDyn: ColorDynamics;
  pose: PoseDynamics;
  noise: NoiseSettings;
  texture: PaperTexture;
  /** Optional second tip multiplied into the primary alpha per pixel.
   *  Older brushes lack this field; the engine treats `undefined` as off. */
  dualTip?: DualTipSettings;
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
    transfer: {
      opacityJitter: identityCurve(),
      flowJitter: identityCurve(),
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
    texture: {
      amount: 0,
      scale: 64,
      followBrush: false,
      mode: "multiply",
      depthJitter: identityCurve(),
    },
    dualTip: {
      enabled: false,
      shape: { kind: "round" },
      sizeRatio: 1,
      angle: 0,
      mix: 1,
      directionFollow: false,
    },
    wetEdges: { enabled: false, amount: 0.5, width: 2 },
    buildUp: { enabled: false, rate: 30 },
    smudge: { enabled: false, strength: 0.6, colorRate: 0 },
    smoothing: { ema: 50, pullString: 0, catchUp: true },
    opacity: 100,
    antiAlias: true,
    motionBlur: 5,
    // A mouse reports pressure 1, so this only shapes pen strokes.
    pressureSize: true,
  };
}

// ─── Serialization ───────────────────────────────────────────────────────────
//
// Brushes are stored as JSON: a bitmap tip's bytes become a string — base64
// in brush files (`paint-brushes.json`, `.vbrush`), a container blob
// reference in `.verve` documents. In memory they're a Uint8Array.

function serializeTip(
  shape: BrushTipShape,
  encode: (bytes: Uint8Array) => string,
): unknown {
  return shape.bitmapRgba
    ? { ...shape, bitmapRgba: encode(shape.bitmapRgba) }
    : shape;
}

function deserializeTip(
  raw: unknown,
  decode: (value: string) => Uint8Array,
): BrushTipShape {
  if (typeof raw !== "object" || raw === null) return { kind: "round" };
  // Older files also stored a derived SDF; it's recomputed now, so drop it.
  const { sdfBase64: _sdf, sdfWidth: _sw, sdfHeight: _sh, ...shape } =
    raw as BrushTipShape & Record<string, unknown>;
  const rgba = (shape as Record<string, unknown>).bitmapRgba;
  if (typeof rgba !== "string") return shape;
  try {
    return { ...shape, bitmapRgba: decode(rgba) };
  } catch {
    return { ...shape, bitmapRgba: undefined };
  }
}

/** A brush as JSON-serializable data; bitmap tip bytes go through `encode`
 *  (base64 by default). */
export function serializeBrush(
  brush: Brush,
  encode: (bytes: Uint8Array) => string = bytesToBase64,
): unknown {
  return {
    ...brush,
    shape: serializeTip(brush.shape, encode),
    ...(brush.dualTip
      ? { dualTip: { ...brush.dualTip, shape: serializeTip(brush.dualTip.shape, encode) } }
      : {}),
  };
}

/** Inverse of `serializeBrush`. */
export function deserializeBrush(
  raw: Record<string, unknown>,
  decode: (value: string) => Uint8Array = base64ToBytes,
): Brush {
  const brush = raw as unknown as Brush;
  return {
    ...brush,
    shape: deserializeTip(brush.shape, decode),
    ...(brush.dualTip
      ? { dualTip: { ...brush.dualTip, shape: deserializeTip(brush.dualTip.shape, decode) } }
      : {}),
  };
}

/** The bitmap-tip payload strings of a serialized brush (main and dual tip). */
export function serializedTipPayloads(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (shape: unknown): void => {
    const v = (shape as Record<string, unknown> | null)?.bitmapRgba;
    if (typeof v === "string") out.push(v);
  };
  add(raw.shape);
  add((raw.dualTip as Record<string, unknown> | undefined)?.shape);
  return out;
}
