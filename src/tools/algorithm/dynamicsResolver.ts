/**
 * Per-stamp evaluation of `DynamicCurve` records.
 *
 * The stamp engine produces a `StampInputs` snapshot at each stamp (current
 * pressure, velocity, tilt, stroke direction, etc.) plus a deterministic
 * per-stamp 32-bit hash for the `random` source. `resolveDynamic` reads any
 * one DynamicCurve and returns a scalar in [0, 1] representing the resolved
 * "intensity" of that dynamic for this stamp.
 *
 * The output convention matches the curve editor:
 *   - When `jitter === 0` or `source === 'off'` → returns 1 (no modulation).
 *   - Otherwise `1 + (target - 1) * jitter`, where `target ∈ [minimum, 1]`
 *     comes from the user's curve evaluated at the source value.
 *
 * Callers multiply this result against base values (size, opacity, scatter
 * radius, etc.). For two-sided dynamics like hue jitter we use the same
 * resolver but interpret the result as a signed offset around 1.
 */
import type { DynamicCurve } from "@/types";
import { evaluateCurve } from "@/utils/dynamicCurve";

export interface StampInputs {
  /** Smoothed pen pressure 0..1 (mouse: held at 0.5). */
  pressure: number;
  /** Normalised stroke speed 0..1 (1 ≈ 5 px/ms). */
  velocity: number;
  /** Pen tilt magnitude 0..1 (sqrt(tiltX² + tiltY²) / 90). */
  tilt: number;
  /** Pen barrel rotation 0..1 (twist / 360). */
  rotation: number;
  /** Stroke direction 0..1 (atan2 wrapped to one full turn). */
  direction: number;
  /** Stamp index since stroke start. Used for `fade`. */
  stampIndex: number;
  /** Deterministic 32-bit hash unique to this (strokeSeed, stampIndex).
   *  Used for boolean decisions where each stamp should be independent
   *  (flip-X/Y jitter, fg/bg swap, scatter direction). */
  hash: number;
  /** Smooth 1-D value noise sample in [0, 1], keyed on (strokeSeed, stampIndex)
   *  with a configurable correlation length. Used by the `random` source so
   *  size/angle/color jitter varies gradually along the stroke instead of
   *  strobing per stamp. */
  noiseSample: number;
}

function hashIntToUnit(seed: number, key: number): number {
  let h = (seed ^ Math.imul(key, 0x9e3779b1)) >>> 0;
  h ^= h << 13;
  h ^= h >>> 17;
  h ^= h << 5;
  return (h >>> 0) / 0x100000000;
}

/**
 * 1-D smooth value noise. Adjacent integer-indexed samples are independently
 * hashed; intermediate `t` values use a smoothstep interpolation between the
 * neighbouring keys. Output is in [0, 1] with a continuous (C¹) profile,
 * which is what you want for size / opacity / colour jitter that tracks the
 * `random` source — uncorrelated per-stamp hashes produce a "strobing"
 * stroke whose thickness jumps abruptly between stamps.
 */
export function smoothNoise1D(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const ff = f * f * (3 - 2 * f);
  const a = hashIntToUnit(seed >>> 0, i);
  const b = hashIntToUnit(seed >>> 0, i + 1);
  return a * (1 - ff) + b * ff;
}

function selectSource(
  curve: DynamicCurve,
  inputs: StampInputs,
): number {
  switch (curve.source) {
    case "pressure":
      return inputs.pressure;
    case "velocity":
      return inputs.velocity;
    case "tilt":
      return inputs.tilt;
    case "rotation":
      return inputs.rotation;
    case "direction":
      return inputs.direction;
    case "random":
      // Smooth 1-D noise — adjacent stamps get correlated values so size /
      // angle / colour jitter glide instead of strobing. Uncorrelated random
      // is still available via `inputs.hash` for boolean dynamics that need
      // per-stamp independence (flip-X/Y, fg/bg swap, scatter direction).
      return inputs.noiseSample;
    case "fade": {
      const total = curve.fadeStamps ?? 25;
      if (total <= 0) return 0;
      // 1 → 0 over `total` stamps. We map to "remaining fraction" so the
      // curve's natural orientation (low x = early stamps) reads correctly.
      return Math.max(0, 1 - inputs.stampIndex / total);
    }
    case "off":
    default:
      return 0;
  }
}

/**
 * Evaluate a curve and return a multiplicative scalar for base values.
 *
 * For dynamics that scale a base value (size, opacity, scatter radius), the
 * caller does `base * resolveDynamic(curve, inputs)`. The result lies in
 * `[1 - jitter, 1]` × the curve's shape (so jitter=0 always returns 1).
 */
export function resolveDynamic(
  curve: DynamicCurve,
  inputs: StampInputs,
): number {
  if (curve.jitter <= 0 || curve.source === "off") return 1;
  const sv = selectSource(curve, inputs);
  const c = Math.min(1, Math.max(0, evaluateCurve(curve.curve, sv)));
  // target ∈ [minimum, 1]
  const target = curve.minimum + (1 - curve.minimum) * c;
  // Blend toward 1 by (1 - jitter). At jitter=1 we return the raw target.
  return 1 + (target - 1) * curve.jitter;
}

/**
 * Variant for symmetric dynamics (angle, hue, sat, brightness) that swing
 * in both directions around 0 rather than scaling toward 1. Returns a
 * continuous signed value in `[-jitter, +jitter]`. The curve shapes the
 * response (e.g. a pressure-driven hue swing can be flat at low pressure
 * and ramp up at high pressure).
 *
 * Source mapping:
 *   - `random` → `(noiseSample − 0.5) × 2` so we get smooth bipolar noise.
 *   - everything else → curve evaluated at the source value, then
 *     `c × 2 − 1` so an identity curve gives `(2 sv − 1)`.
 *
 * `minimum` is **not** applied here. Treating it as a "deadzone" (snap to 0
 * inside ±minimum) introduced visible binary behaviour in colour jitter —
 * the hue / saturation / brightness offsets would step abruptly at the
 * threshold instead of fading. The slider is currently a no-op for
 * symmetric dynamics; if a use case for an amplitude floor emerges later
 * it can be reintroduced as a smooth transform (e.g. a magnitude curve
 * compression) rather than a hard cutoff.
 */
export function resolveSymmetric(
  curve: DynamicCurve,
  inputs: StampInputs,
): number {
  if (curve.jitter <= 0 || curve.source === "off") return 0;
  const sv = selectSource(curve, inputs);
  let signed: number;
  if (curve.source === "random") {
    signed = (sv - 0.5) * 2; // -1..1
  } else {
    const c = Math.min(1, Math.max(0, evaluateCurve(curve.curve, sv)));
    signed = c * 2 - 1; // -1..1
  }
  return signed * curve.jitter;
}

/** xorshift32 — fast deterministic per-stamp hash. */
export function stampHash(strokeSeed: number, stampIndex: number): number {
  let h = (strokeSeed ^ (stampIndex + 0x9e3779b9)) >>> 0;
  h ^= h << 13;
  h ^= h >>> 17;
  h ^= h << 5;
  return h >>> 0;
}

/** Boolean flip with probability `p ∈ [0, 1]`, sampling from the stamp hash. */
export function shouldFlip(p: number, hash: number, salt: number): boolean {
  if (p <= 0) return false;
  // Mix the hash with a salt so flipX and flipY decisions are independent.
  let h = (hash ^ (salt * 0x85ebca6b)) >>> 0;
  h ^= h << 13;
  h ^= h >>> 17;
  return (h >>> 0) / 0x100000000 < p;
}
