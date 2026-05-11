/**
 * Brush-tip SDF samplers.
 *
 * `TipSampler` is the runtime cache for one captured brush tip: it wraps the
 * precomputed SDF (for bitmap tips) or holds nothing extra (for procedural
 * shapes — round/square/diamond — which are sampled analytically).
 *
 * The stamp engine asks for the SDF at a point in tip-local coordinates
 * normalised to a unit disc: (-1, -1) is the upper-left of the tip, (1, 1)
 * the lower-right. The returned distance is in *unit* coordinates (the same
 * scale as the input), so the engine multiplies by the brush radius to get
 * canvas-pixel distances.
 *
 * Procedural shapes give exact, infinitely scalable distances; bitmap SDFs
 * give clean scaling because the field is band-limited and bilinearly
 * interpolated at sample time.
 */
import type { BrushTipShape } from "@/types";
import { computeSdfFromRgba, sdfFromBase64, sdfToBase64 } from "../_shared/sdf";

export interface TipSampler {
  /** Aspect ratio of the source bitmap (height / width). 1 for procedural. */
  readonly aspect: number;
  /**
   * Sample the unit SDF at `(u, v) ∈ [-1, 1]²`. Negative = inside, positive
   * = outside, ~0 on silhouette. Out-of-range returns a large positive.
   */
  sample(u: number, v: number): number;
  /**
   * For bitmap tips only — the precomputed pixel-distance SDF. The WASM
   * brush kernel reads it directly to avoid the JS sample callback. Procedural
   * samplers leave this undefined (the kernel branches on `tipKind`). */
  readonly bitmapSdf?: Float32Array;
  readonly bitmapSdfW?: number;
  readonly bitmapSdfH?: number;
  /** 0=round, 1=square, 2=diamond, 3=bitmap — used by the WASM kernel
   *  dispatch to pick the right SDF function. */
  readonly tipKind: 0 | 1 | 2 | 3;
}

// ─── Procedural samplers ─────────────────────────────────────────────────────

class RoundSampler implements TipSampler {
  readonly aspect = 1;
  readonly tipKind = 0 as const;
  sample(u: number, v: number): number {
    return Math.hypot(u, v) - 1;
  }
}

class SquareSampler implements TipSampler {
  readonly aspect = 1;
  readonly tipKind = 1 as const;
  sample(u: number, v: number): number {
    const ax = Math.abs(u);
    const ay = Math.abs(v);
    return Math.max(ax, ay) - 1;
  }
}

class DiamondSampler implements TipSampler {
  readonly aspect = 1;
  readonly tipKind = 2 as const;
  sample(u: number, v: number): number {
    return Math.abs(u) + Math.abs(v) - 1;
  }
}

const ROUND = new RoundSampler();
const SQUARE = new SquareSampler();
const DIAMOND = new DiamondSampler();

// ─── Bitmap SDF sampler (bilinear) ───────────────────────────────────────────

class BitmapSdfSampler implements TipSampler {
  readonly aspect: number;
  readonly tipKind = 3 as const;
  /** SDF in pixel units. Public so the WASM kernel can read it directly. */
  readonly bitmapSdf: Float32Array;
  readonly bitmapSdfW: number;
  readonly bitmapSdfH: number;
  private readonly sdf: Float32Array;
  private readonly w: number;
  private readonly h: number;
  /** Reciprocal of half the bitmap's longer edge — used to convert pixel
   *  distances back to unit distances. */
  private readonly unitScale: number;

  constructor(sdf: Float32Array, w: number, h: number) {
    this.sdf = sdf;
    this.w = w;
    this.h = h;
    this.bitmapSdf = sdf;
    this.bitmapSdfW = w;
    this.bitmapSdfH = h;
    this.aspect = h / w;
    // Use the longer half-edge so the tip's bounding box fits in [-1, 1].
    const halfMax = Math.max(w, h) * 0.5;
    this.unitScale = 1 / halfMax;
  }

  sample(u: number, v: number): number {
    // Map unit space (-1..1) to pixel space (0..w-1, 0..h-1) centered on the
    // bitmap. Asymmetric bitmaps fit by using the longer half-edge as 1.
    const halfMax = Math.max(this.w, this.h) * 0.5;
    const px = (u * halfMax) + this.w * 0.5 - 0.5;
    const py = (v * halfMax) + this.h * 0.5 - 0.5;

    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const fx = px - x0;
    const fy = py - y0;

    // Out-of-bounds: return a large positive proportional to outside distance.
    if (x1 < 0 || y1 < 0 || x0 >= this.w || y0 >= this.h) {
      const cx = this.w * 0.5;
      const cy = this.h * 0.5;
      const distPx = Math.hypot(px - cx, py - cy);
      return distPx * this.unitScale;
    }

    const cx0 = Math.max(0, Math.min(this.w - 1, x0));
    const cy0 = Math.max(0, Math.min(this.h - 1, y0));
    const cx1 = Math.max(0, Math.min(this.w - 1, x1));
    const cy1 = Math.max(0, Math.min(this.h - 1, y1));

    const s00 = this.sdf[cy0 * this.w + cx0];
    const s10 = this.sdf[cy0 * this.w + cx1];
    const s01 = this.sdf[cy1 * this.w + cx0];
    const s11 = this.sdf[cy1 * this.w + cx1];
    const sxy =
      s00 * (1 - fx) * (1 - fy) +
      s10 * fx * (1 - fy) +
      s01 * (1 - fx) * fy +
      s11 * fx * fy;

    return sxy * this.unitScale;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a `TipSampler` for the given `BrushTipShape`. For bitmap tips, the
 * SDF is loaded from `sdfBase64` if present, otherwise computed lazily from
 * `bitmapRgba`. The result is a self-contained sampler safe to share across
 * strokes — the caller should cache it keyed by tip identity (e.g. shape
 * object reference) to avoid recomputing per-stroke.
 */
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
      if (w <= 0 || h <= 0) return ROUND; // missing data → safe fallback
      let sdf: Float32Array;
      if (shape.sdfBase64 && shape.sdfWidth === w && shape.sdfHeight === h) {
        sdf = sdfFromBase64(shape.sdfBase64, w, h);
      } else if (shape.bitmapRgba) {
        const bin = atob(shape.bitmapRgba);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        sdf = computeSdfFromRgba(bytes, w, h);
      } else {
        return ROUND;
      }
      return new BitmapSdfSampler(sdf, w, h);
    }
  }
}

/** Compute the SDF for a captured bitmap tip and return a base64-encoded blob. */
export function makeSdfForBitmapTip(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): { base64: string; width: number; height: number } {
  const sdf = computeSdfFromRgba(rgba, width, height);
  return { base64: sdfToBase64(sdf), width, height };
}

// ─── LRU cache so the engine doesn't recompute on every stroke ──────────────

const SAMPLER_CACHE: WeakMap<BrushTipShape, TipSampler> = new WeakMap();

export function getCachedTipSampler(shape: BrushTipShape): TipSampler {
  let s = SAMPLER_CACHE.get(shape);
  if (!s) {
    s = makeTipSampler(shape);
    SAMPLER_CACHE.set(shape, s);
  }
  return s;
}
