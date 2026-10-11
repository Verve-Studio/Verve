/**
 * Brush-tip samplers and the per-pixel tip coverage model.
 *
 * The stamp engine maps each pixel into tip-local *unit* coordinates
 * (`(u, v) ∈ [-1, 1]²` spans the tip; roundness squashes `v`) and asks for
 * the tip's coverage there. The math is mirrored by the WASM kernel
 * (`wasm/src/brush_stamp.cpp`, `tip_coverage`) — keep the two in sync.
 *
 * Procedural tips (round / square / diamond) are analytic signed distance
 * fields. Coverage = soft core × anti-aliased edge:
 *   - The soft core is `smoothstep(depth / softness)`, where depth is the
 *     unit distance inside the silhouette (0 at the edge, 1 at the centre)
 *     and softness = 1 − hardness. Hardness is therefore the size of the
 *     fully opaque core, and a soft brush fades out *within* its diameter
 *     (Photoshop semantics) instead of spilling past it.
 *   - The edge is a 1 px box filter on the true pixel distance to the
 *     silhouette (unit distance ÷ the SDF's gradient in pixels), so squashed
 *     (low roundness) tips stay anti-aliased along their thin side too.
 *
 * Bitmap tips are sampled brushes: a paint-density map (0..1) derived from
 * the captured pixels, kept as a box-filtered mip pyramid. The engine picks
 * the level whose resolution matches the dab size, so large captures stay
 * smooth when painted small and keep their internal texture (bristles,
 * charcoal grain) at any size.
 */
import type { BrushTipShape } from "@/types";

/** One mip level of a bitmap tip's density map (row-major, 0..1). */
export interface TipLevel {
  readonly data: Float32Array;
  readonly w: number;
  readonly h: number;
}

export interface TipSampler {
  /** 0=round, 1=square, 2=diamond, 3=bitmap — the WASM kernel's tip kind. */
  readonly tipKind: 0 | 1 | 2 | 3;
  /** Bitmap tips only: the density pyramid, level 0 = full resolution. */
  readonly levels?: readonly TipLevel[];
}

// ─── Procedural tips ─────────────────────────────────────────────────────────

const ROUND: TipSampler = { tipKind: 0 };
const SQUARE: TipSampler = { tipKind: 1 };
const DIAMOND: TipSampler = { tipKind: 2 };

/**
 * Coverage of a procedural tip at tip-local unit coords `(u, v)`.
 *
 * `invR` / `invRY` convert pixels to unit space along the tip's x / y axes
 * (1 / radius, 1 / (radius × roundness)). `softness` ∈ [0, 1]; `aa` = false
 * gives an aliased (pixel-art) edge.
 */
export function proceduralCoverage(
  tipKind: 0 | 1 | 2,
  u: number,
  v: number,
  invR: number,
  invRY: number,
  softness: number,
  aa: boolean,
): number {
  let sdf: number;
  // |∇sdf| in unit-per-pixel — divides a unit distance into pixels.
  let grad: number;
  if (tipKind === 0) {
    const len = Math.sqrt(u * u + v * v);
    sdf = len - 1;
    const l = len > 1e-6 ? len : 1e-6;
    grad = Math.sqrt(u * u * invR * invR + v * v * invRY * invRY) / l;
  } else if (tipKind === 1) {
    const au = Math.abs(u);
    const av = Math.abs(v);
    if (au > av) {
      sdf = au - 1;
      grad = invR;
    } else {
      sdf = av - 1;
      grad = invRY;
    }
  } else {
    sdf = Math.abs(u) + Math.abs(v) - 1;
    grad = Math.sqrt(invR * invR + invRY * invRY);
  }
  let edge: number;
  if (aa) {
    const distPx = grad > 0 ? sdf / grad : sdf;
    if (distPx >= 0.5) return 0;
    edge = distPx <= -0.5 ? 1 : 0.5 - distPx;
  } else {
    if (sdf > 0) return 0;
    edge = 1;
  }
  if (softness <= 0) return edge;
  const x = -sdf / softness;
  if (x <= 0) return 0;
  if (x >= 1) return edge;
  return edge * x * x * (3 - 2 * x);
}

/**
 * Coverage of a round tip swept from the segment start `(su, sv)` (tip-local
 * unit coords, radius `k0` there as a fraction of this radius) to the
 * centre: the distance is taken to the segment instead of the centre, so
 * consecutive dabs join into the continuous stroke with no ripple. Pixels
 * behind the segment start belong to the previous dab and get 0.
 */
export function sweptRoundCoverage(
  u: number,
  v: number,
  su: number,
  sv: number,
  k0: number,
  invR: number,
  invRY: number,
  softness: number,
  aa: boolean,
): number {
  const len2 = su * su + sv * sv;
  let t = len2 > 1e-8 ? -((u - su) * su + (v - sv) * sv) / len2 : 1;
  // Behind the segment start the previous dab already painted this pixel
  // with the same coverage (its end): nothing to add.
  if (t < 0) return 0;
  if (t > 1) t = 1;
  const w = 1 - t;
  const cu = u - su * w;
  const cv = v - sv * w;
  const len = Math.sqrt(cu * cu + cv * cv);
  const k = k0 + (1 - k0) * t;
  const sdf = len - k;
  const l = len > 1e-6 ? len : 1e-6;
  const grad = Math.sqrt(cu * cu * invR * invR + cv * cv * invRY * invRY) / l;
  let edge: number;
  if (aa) {
    const distPx = sdf / (grad > 1e-12 ? grad : 1e-12);
    if (distPx >= 0.5) return 0;
    edge = distPx <= -0.5 ? 1 : 0.5 - distPx;
  } else {
    if (sdf > 0) return 0;
    edge = 1;
  }
  if (softness <= 0) return edge;
  const x = -sdf / (k * softness);
  if (x <= 0) return 0;
  if (x >= 1) return edge;
  return edge * x * x * (3 - 2 * x);
}

/**
 * Coverage of the dual tip (a hard, 1 px anti-aliased silhouette; isotropic,
 * `dualRadius` in pixels).
 */
export function dualProceduralCoverage(
  tipKind: 0 | 1 | 2,
  u: number,
  v: number,
  dualRadius: number,
): number {
  let sdf: number;
  let grad = 1;
  if (tipKind === 0) sdf = Math.sqrt(u * u + v * v) - 1;
  else if (tipKind === 1) sdf = Math.max(Math.abs(u), Math.abs(v)) - 1;
  else {
    sdf = Math.abs(u) + Math.abs(v) - 1;
    grad = Math.SQRT2;
  }
  const distPx = (sdf * dualRadius) / grad;
  if (distPx >= 0.5) return 0;
  if (distPx <= -0.5) return 1;
  return 0.5 - distPx;
}

// ─── Bitmap (sampled) tips ───────────────────────────────────────────────────

/** Bilinear density lookup; texels outside the map are empty. */
export function sampleTipLevel(level: TipLevel, u: number, v: number): number {
  const { data, w, h } = level;
  const halfMax = (w > h ? w : h) * 0.5;
  const px = u * halfMax + w * 0.5 - 0.5;
  const py = v * halfMax + h * 0.5 - 0.5;
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  if (x0 < -1 || y0 < -1 || x0 >= w || y0 >= h) return 0;
  const fx = px - x0;
  const fy = py - y0;
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const inX0 = x0 >= 0;
  const inX1 = x1 < w;
  const inY0 = y0 >= 0;
  const inY1 = y1 < h;
  const s00 = inX0 && inY0 ? data[y0 * w + x0] : 0;
  const s10 = inX1 && inY0 ? data[y0 * w + x1] : 0;
  const s01 = inX0 && inY1 ? data[y1 * w + x0] : 0;
  const s11 = inX1 && inY1 ? data[y1 * w + x1] : 0;
  return (
    (s00 * (1 - fx) + s10 * fx) * (1 - fy) + (s01 * (1 - fx) + s11 * fx) * fy
  );
}

/**
 * The mip level to sample for a dab `diameterPx` wide: the smallest level
 * whose longer edge still covers the diameter (≤ 2:1 minification for
 * bilinear), or the full-resolution level when the dab is larger.
 */
export function tipLevelFor(
  levels: readonly TipLevel[],
  diameterPx: number,
): TipLevel {
  for (let i = levels.length - 1; i > 0; i--) {
    const l = levels[i];
    if ((l.w > l.h ? l.w : l.h) >= diameterPx) return l;
  }
  return levels[0];
}

/**
 * Paint density of a captured RGBA tip. A capture with real transparency
 * (a shape painted on an empty layer) uses its alpha; an opaque capture
 * (marks on a white background) uses darkness, like Photoshop's Define
 * Brush — black lays down full paint, white none.
 */
function densityFromRgba(rgba: Uint8Array, w: number, h: number): Float32Array {
  const n = w * h;
  let translucent = 0;
  for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] < 250) translucent++;
  const useAlpha = translucent > n * 0.01;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    if (useAlpha) {
      out[i] = a;
    } else {
      const luma =
        (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) /
        255;
      out[i] = (1 - luma) * a;
    }
  }
  return out;
}

/** 2×2 box-filtered half-resolution level (texels past the edge are empty). */
function downsample(level: TipLevel): TipLevel {
  const w = Math.max(1, Math.ceil(level.w / 2));
  const h = Math.max(1, Math.ceil(level.h / 2));
  const src = level.data;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy0 = y * 2;
    const sy1 = sy0 + 1;
    for (let x = 0; x < w; x++) {
      const sx0 = x * 2;
      const sx1 = sx0 + 1;
      let s = src[sy0 * level.w + sx0];
      if (sx1 < level.w) s += src[sy0 * level.w + sx1];
      if (sy1 < level.h) {
        s += src[sy1 * level.w + sx0];
        if (sx1 < level.w) s += src[sy1 * level.w + sx1];
      }
      out[y * w + x] = s * 0.25;
    }
  }
  return { data: out, w, h };
}

function makeBitmapSampler(rgba: Uint8Array, w: number, h: number): TipSampler {
  const levels: TipLevel[] = [{ data: densityFromRgba(rgba, w, h), w, h }];
  for (;;) {
    const last = levels[levels.length - 1];
    if (last.w <= 2 && last.h <= 2) break;
    levels.push(downsample(last));
  }
  return { tipKind: 3, levels };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Build a `TipSampler` for the given `BrushTipShape`. */
export function makeTipSampler(shape: BrushTipShape): TipSampler {
  switch (shape.kind) {
    case "round":
      return ROUND;
    case "square":
      return SQUARE;
    case "diamond":
      return DIAMOND;
    case "bitmap": {
      const w = shape.bitmapWidth ?? 0;
      const h = shape.bitmapHeight ?? 0;
      const rgba = shape.bitmapRgba;
      // Missing or malformed data → safe fallback.
      if (w <= 0 || h <= 0 || !rgba || rgba.length !== w * h * 4) return ROUND;
      return makeBitmapSampler(rgba, w, h);
    }
  }
}

// Cached per shape object so the density pyramid is built once per tip.
const SAMPLER_CACHE: WeakMap<BrushTipShape, TipSampler> = new WeakMap();

export function getCachedTipSampler(shape: BrushTipShape): TipSampler {
  let s = SAMPLER_CACHE.get(shape);
  if (!s) {
    s = makeTipSampler(shape);
    SAMPLER_CACHE.set(shape, s);
  }
  return s;
}
