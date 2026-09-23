/**
 * The pencil's pixel footprint — one rule shared by the cursor preview, the
 * rgba stamp (hard edge) and the indexed8 stamp, so what the preview shows is
 * exactly what gets painted.
 *
 * A size-N stamp at integer pixel (cx, cy) covers the N×N box whose first
 * column/row is `cx - floor(N / 2)`; its centre is half a pixel up-left of
 * (cx, cy) for even N. A pixel is inside when its centre, at offset (ox, oy)
 * from that footprint centre, satisfies:
 *   round:   ox² + oy² ≤ N²/4 − 0.5   (2×2 at 2, plus at 3, 12 px at 4, …)
 *   square:  always (the whole box)
 *   diamond: |ox| + |oy| ≤ (N − 1)/2, + 0.5 for even N
 */

export type PencilShape = "round" | "square" | "diamond";

/** Offset of the footprint centre from the stamp pixel (0 or -0.5). */
export function footprintCentreOffset(size: number): number {
  return size % 2 === 0 ? -0.5 : 0;
}

/** First pixel offset (relative to the stamp pixel) of a size-N footprint. */
export function footprintStart(size: number): number {
  return -Math.floor(size / 2);
}

/** Whether the pixel at offset (ox, oy) from the footprint centre is inside. */
export function inPencilFootprint(
  ox: number,
  oy: number,
  size: number,
  shape: PencilShape,
): boolean {
  if (size <= 1) return ox === 0 && oy === 0;
  if (shape === "square") {
    const h = (size - 1) / 2;
    return Math.abs(ox) <= h && Math.abs(oy) <= h;
  }
  if (shape === "diamond") {
    const lim = (size - 1) / 2 + (size % 2 === 0 ? 0.5 : 0);
    return Math.abs(ox) + Math.abs(oy) <= lim + 1e-9;
  }
  return ox * ox + oy * oy <= (size * size) / 4 - 0.5 + 1e-9;
}
