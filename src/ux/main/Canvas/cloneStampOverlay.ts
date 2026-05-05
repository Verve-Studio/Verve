/**
 * Draws the clone stamp source marker and (optionally) a dashed line from the
 * source position to the current brush position.
 *
 * Call from:
 *  - the cloneStampStore subscriber in Canvas.tsx (on source change)
 *  - the onHover callback in Canvas.tsx (on every pointer move)
 *
 * @param oc         The tool overlay canvas (toolOverlayRef)
 * @param sourceX/Y  Canvas-space source point position
 * @param brushX/Y   Canvas-space current brush position (pointer pos)
 * @param showLine   Draw the dashed offset line
 */
export function drawCloneStampOverlay(
  oc: HTMLCanvasElement,
  sourceX: number,
  sourceY: number,
  brushX: number,
  brushY: number,
  showLine: boolean,
): void {
  const ctx = oc.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, oc.width, oc.height);

  // Coordinates are canvas-space — the overlay canvas has the same pixel
  // dimensions as the WebGPU canvas, scaled via CSS, so we draw directly
  // in canvas-space pixels.
  const sx = sourceX + 0.5;
  const sy = sourceY + 0.5;

  // ── Dashed offset line ──────────────────────────────────────────
  if (showLine && (brushX !== sourceX || brushY !== sourceY)) {
    const bx = brushX + 0.5;
    const by = brushY + 0.5;
    ctx.save();
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // ── Source crosshair marker ─────────────────────────────────────
  const armLen = 12; // half length of crosshair arms
  const circR = 8; // inner circle radius

  ctx.save();

  // Shadow pass (dark outline)
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = 2.5;

  // Horizontal arms (left + right, through center)
  ctx.beginPath();
  ctx.moveTo(sx - armLen, sy);
  ctx.lineTo(sx + armLen, sy);
  // Vertical arms (top + bottom, through center)
  ctx.moveTo(sx, sy - armLen);
  ctx.lineTo(sx, sy + armLen);
  ctx.stroke();

  // Circle
  ctx.beginPath();
  ctx.arc(sx, sy, circR, 0, Math.PI * 2);
  ctx.stroke();

  // White pass
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 1.5;

  ctx.beginPath();
  ctx.moveTo(sx - armLen, sy);
  ctx.lineTo(sx + armLen, sy);
  ctx.moveTo(sx, sy - armLen);
  ctx.lineTo(sx, sy + armLen);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(sx, sy, circR, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}
