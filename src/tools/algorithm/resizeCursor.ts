/**
 * Resize-cursor helpers for tools that draw bounding-box handles.
 *
 * The eight scale handles share the same canonical layout across the shape,
 * frame and transform tools:
 *
 *   0 TL   1 TC   2 TR
 *   3 ML          4 MR
 *   5 BL   6 BC   7 BR
 *
 * Each handle's "local" angle (relative to the shape's centre, before
 * rotation) is fixed; combined with the shape's rotation it yields the
 * on-screen direction along which the user will drag — and from that we pick
 * the matching `*-resize` cursor.
 */

/** Local angle (in degrees, screen-space — +X right, +Y down) of each scale
 *  handle as measured from the shape's centre. Indices 0..7 only. */
const HANDLE_LOCAL_ANGLE_DEG = [
  -135, // 0 TL
  -90, // 1 TC
  -45, // 2 TR
  180, // 3 ML
  0, // 4 MR
  135, // 5 BL
  90, // 6 BC
  45, // 7 BR
];

/**
 * Map a screen-space angle (degrees) to the appropriate `*-resize` cursor.
 * Resize cursors are symmetric across 180°, so we collapse the angle into
 * 0..180 and bucket into the four directional cursors.
 */
export function angleToResizeCursor(
  angleDeg: number,
): "ew-resize" | "ns-resize" | "nesw-resize" | "nwse-resize" {
  // Normalise to 0..180 (resize cursors are direction-symmetric).
  const a = (((angleDeg % 180) + 180) % 180);
  if (a < 22.5 || a >= 157.5) return "ew-resize";
  if (a < 67.5) return "nwse-resize";
  if (a < 112.5) return "ns-resize";
  return "nesw-resize";
}

/**
 * Get the appropriate `*-resize` cursor for handle index 0..7 on a shape
 * whose rotation is `rotationDeg` degrees clockwise. Returns `null` for
 * indices outside 0..7 (e.g. rotation handle, pivot, perspective corners) so
 * the caller can decide on a different cursor.
 */
export function resizeCursorForHandle(
  handleIdx: number,
  rotationDeg: number,
): string | null {
  if (handleIdx < 0 || handleIdx > 7) return null;
  return angleToResizeCursor(HANDLE_LOCAL_ANGLE_DEG[handleIdx] + rotationDeg);
}
