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
  /** Deterministic 32-bit hash unique to this (strokeSeed, stampIndex). */
  hash: number;
}

/** Convert the stamp hash to a uniform 0..1 sample for the `random` source. */
function hashToUnit(h: number): number {
  // Multiply by 1/2^32; bias by 0.5 so 0 → 0.5 (mid-curve) like Photoshop.
  return ((h >>> 0) / 0x100000000);
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
      return hashToUnit(inputs.hash);
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
 * Variant for symmetric dynamics (angle, hue, etc.) that should swing in both
 * directions around 0 rather than scaling toward 1. Returns a signed value
 * in roughly `[-jitter, +jitter]`. The curve still shapes the response (e.g.
 * pressure-driven angle wobble can be made gentle near light pressure).
 *
 * For `random` source we centre the unit hash to `[-0.5, +0.5]` then double
 * for full ±1 range. For deterministic sources (pressure, velocity, …) we
 * return the curve directly minus 0.5 (so identity curve gives 0).
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
  // Apply minimum as a "deadzone" — values within ±minimum get pulled to 0.
  if (Math.abs(signed) < curve.minimum) signed = 0;
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
