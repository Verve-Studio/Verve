/**
 * Format-native geometry transforms for a layer's pixel buffer, used by the
 * canvas-dimension operations (Resize Image, Resize Canvas, Crop).
 *
 * Buffers stay in the layer's own format and layer-local space: rgba32f
 * keeps scene-linear floats (HDR values > 1 survive), indexed8 keeps
 * palette indices (no re-quantisation), rgba8 keeps bytes. The result
 * carries the layer's new geometry on the new canvas.
 */
import type { PixelFormat } from "@/types";
import { resizeLayer } from "@/wasm";

export interface LayerBuffer {
  data: Uint8Array | Float32Array;
  format: PixelFormat;
  width: number;
  height: number;
  /** Top-left on the canvas. */
  offsetX: number;
  offsetY: number;
}

export type ResampleFilter = "bilinear" | "nearest";

const channelsOf = (format: PixelFormat): number => (format === "indexed8" ? 1 : 4);

function allocate(format: PixelFormat, width: number, height: number): Uint8Array | Float32Array {
  const n = width * height * channelsOf(format);
  if (format === "rgba32f") return new Float32Array(n);
  const out = new Uint8Array(n);
  // 255 is indexed8's transparent sentinel.
  if (format === "indexed8") out.fill(255);
  return out;
}

/** A 1×1 transparent layer (a layer fully outside the new canvas). */
function emptyLayer(format: PixelFormat): LayerBuffer {
  return { data: allocate(format, 1, 1), format, width: 1, height: 1, offsetX: 0, offsetY: 0 };
}

/**
 * Move the layer by (dx, dy) and clip it to a `canvasW` × `canvasH`
 * canvas. Crop is a move by (-x, -y) onto the crop size; Resize Canvas a
 * move by the anchor offset onto the new size.
 */
export function clipLayerToCanvas(
  src: LayerBuffer,
  dx: number,
  dy: number,
  canvasW: number,
  canvasH: number,
): LayerBuffer {
  const ox = src.offsetX + dx;
  const oy = src.offsetY + dy;
  const x0 = Math.max(0, ox);
  const y0 = Math.max(0, oy);
  const x1 = Math.min(canvasW, ox + src.width);
  const y1 = Math.min(canvasH, oy + src.height);
  if (x1 <= x0 || y1 <= y0) return emptyLayer(src.format);

  const ch = channelsOf(src.format);
  const w = x1 - x0;
  const h = y1 - y0;
  const out = allocate(src.format, w, h);
  for (let row = 0; row < h; row++) {
    const s = ((y0 - oy + row) * src.width + (x0 - ox)) * ch;
    (out as Uint8Array).set((src.data as Uint8Array).subarray(s, s + w * ch), row * w * ch);
  }
  return { data: out, format: src.format, width: w, height: h, offsetX: x0, offsetY: y0 };
}

// ─── Resampling ───────────────────────────────────────────────────────────────

/** Output footprint of the layer on the new canvas along one axis. */
function footprint(offset: number, size: number, scale: number, newCanvas: number): [number, number] {
  const a = Math.max(0, Math.floor(offset * scale));
  const b = Math.min(newCanvas, Math.ceil((offset + size) * scale));
  return [a, Math.max(a + 1, b)];
}

/**
 * Scale the layer from an `oldW` × `oldH` canvas to `newW` × `newH` (the
 * WASM `resizeLayer` kernel). Indexed layers always use nearest neighbour
 * (palette indices can't be interpolated); RGBA layers use `filter` —
 * "bilinear" is a tent filter that averages the source footprint when
 * downscaling. Layers stay registered on the canvas.
 */
export async function resampleLayer(
  src: LayerBuffer,
  oldW: number,
  oldH: number,
  newW: number,
  newH: number,
  filter: ResampleFilter,
): Promise<LayerBuffer> {
  const sx = newW / oldW;
  const sy = newH / oldH;
  const [x0, x1] = footprint(src.offsetX, src.width, sx, newW);
  const [y0, y1] = footprint(src.offsetY, src.height, sy, newH);
  if (x0 >= newW || y0 >= newH) return emptyLayer(src.format);
  const dst = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const data = await resizeLayer(src, oldW, oldH, sx, sy, dst, filter);
  return { data, format: src.format, width: dst.width, height: dst.height, offsetX: dst.x, offsetY: dst.y };
}

/** The layer composited into a transparent canvas-sized RGBA8 buffer
 *  (for canvas-sized masks). */
export function toCanvasSized(buf: LayerBuffer, canvasW: number, canvasH: number): Uint8Array {
  const out = new Uint8Array(canvasW * canvasH * 4);
  const clipped = clipLayerToCanvas(buf, 0, 0, canvasW, canvasH);
  for (let row = 0; row < clipped.height; row++) {
    const s = row * clipped.width * 4;
    out.set(
      (clipped.data as Uint8Array).subarray(s, s + clipped.width * 4),
      ((clipped.offsetY + row) * canvasW + clipped.offsetX) * 4,
    );
  }
  return out;
}
