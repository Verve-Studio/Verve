/**
 * Curve evaluation for brush dynamics.
 *
 * The brush panel UI lets users edit a `DynamicCurve` as a list of (x, y)
 * control points. At paint time, the engine resolves a per-stamp value by
 * (1) selecting an input source (pressure, velocity, fade, …), (2) sampling
 * this curve, and (3) blending between `minimum` and base value.
 *
 * `evaluateCurve` uses monotone-Catmull–Rom interpolation: smooth, never
 * overshoots above the maximum control-point y, never dips below the minimum.
 * Endpoints are clamped to (0, *) and (1, *) so the function is fully defined
 * over [0, 1].
 */
import type { DynamicCurve } from "@/types";

/** Sample a curve at x ∈ [0, 1]. Out-of-range x is clamped. */
export function evaluateCurve(
  points: { x: number; y: number }[],
  x: number,
): number {
  if (points.length === 0) return x;
  if (points.length === 1) return points[0].y;
  const xc = Math.min(1, Math.max(0, x));

  // Find the segment.
  let i = 0;
  for (; i < points.length - 1; i++) {
    if (xc <= points[i + 1].x) break;
  }
  if (i >= points.length - 1) return points[points.length - 1].y;

  const p1 = points[i];
  const p2 = points[i + 1];
  const dx = p2.x - p1.x;
  if (dx <= 0) return p2.y;
  const t = (xc - p1.x) / dx;

  // Monotone cubic (Fritsch–Carlson). Compute tangents that don't overshoot.
  const slope = (a: { y: number }, b: { y: number }, h: number): number =>
    h > 0 ? (b.y - a.y) / h : 0;

  const m1 = i > 0 ? slope(points[i - 1], p2, p2.x - points[i - 1].x) : slope(p1, p2, dx);
  const m2 =
    i < points.length - 2
      ? slope(p1, points[i + 2], points[i + 2].x - p1.x)
      : slope(p1, p2, dx);

  const d = (p2.y - p1.y) / dx;
  // Monotonicity guard
  const t1 = d === 0 ? 0 : Math.max(0, Math.min(m1 / d, 3)) * d;
  const t2 = d === 0 ? 0 : Math.max(0, Math.min(m2 / d, 3)) * d;

  const t_2 = t * t;
  const t_3 = t_2 * t;
  const h00 = 2 * t_3 - 3 * t_2 + 1;
  const h10 = t_3 - 2 * t_2 + t;
  const h01 = -2 * t_3 + 3 * t_2;
  const h11 = t_3 - t_2;

  return h00 * p1.y + h10 * dx * t1 + h01 * p2.y + h11 * dx * t2;
}

/**
 * Resolve a dynamic to a per-stamp scalar in [0, 1]. The engine picks the
 * input value (`source`) externally and passes it as `sourceValue`.
 *
 * - Returns 1 (no modulation) when `jitter === 0` or `source === 'off'`.
 * - Otherwise, blends between `minimum` and 1 using the curve evaluated at
 *   `sourceValue`, scaled by `jitter`.
 */
export function resolveDynamic(
  curve: DynamicCurve,
  sourceValue: number,
): number {
  if (curve.jitter <= 0 || curve.source === "off") return 1;
  const c = Math.min(1, Math.max(0, evaluateCurve(curve.curve, sourceValue)));
  // Blend: at jitter=0 → 1; at jitter=1 → curve mapped between minimum and 1.
  const target = curve.minimum + (1 - curve.minimum) * c;
  return 1 + (target - 1) * curve.jitter;
}
