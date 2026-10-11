/**
 * Capture a brush tip from the current selection on the active layer.
 *
 * The captured tip stores the cropped RGBA bitmap. The stamp engine samples
 * an 8SSEDT-derived signed distance field of its alpha (computed and cached
 * by `getCachedTipSampler`) — it gives clean scaling to any brush size and
 * naturally feathered edges via the hardness smoothstep, regardless of the
 * source bitmap's resolution.
 */
import type { BrushTipShape } from "@/types";

export interface CaptureBrushArgs {
  canvasWidth: number;
  canvasHeight: number;
  /** Layer pixels in canvas-size RGBA buffer (pixels outside layer bounds are transparent). */
  layerPixels: Uint8Array;
  /** Selection mask, canvas-sized, 0 = unselected, non-zero = selected. */
  selectionMask: Uint8Array;
}

export function captureBrushTipFromSelection(
  args: CaptureBrushArgs,
): BrushTipShape | null {
  const { canvasWidth: cw, canvasHeight: ch, layerPixels, selectionMask } = args;
  if (selectionMask.length !== cw * ch) return null;
  if (layerPixels.length !== cw * ch * 4) return null;

  // Tight bounding box of selection
  let minX = cw;
  let minY = ch;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (selectionMask[y * cw + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX > maxX || minY > maxY) return null;

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const out = new Uint8Array(bw * bh * 4);

  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const cx = minX + x;
      const cy = minY + y;
      if (!selectionMask[cy * cw + cx]) continue;
      const src = (cy * cw + cx) * 4;
      const dst = (y * bw + x) * 4;
      out[dst] = layerPixels[src];
      out[dst + 1] = layerPixels[src + 1];
      out[dst + 2] = layerPixels[src + 2];
      out[dst + 3] = layerPixels[src + 3];
    }
  }

  return {
    kind: "bitmap",
    bitmapRgba: out,
    bitmapWidth: bw,
    bitmapHeight: bh,
  };
}
