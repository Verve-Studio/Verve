import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { indexedSelected } from "@/core/tools/_shared/primitives";

/**
 * Remove the selected pixels of `layer` (Edit → Delete, cut, content-aware
 * delete). `mask` is the canvas-sized selection (0–255), `canvasWidth` its
 * row stride. Soft selections remove a fraction of each pixel: in straight
 * alpha that only lowers alpha (scaling RGB too darkened soft edges); a fully
 * selected pixel is cleared to 0. Indexed8 has no partial alpha, so the mask
 * is thresholded at 50% and selected pixels become the transparent sentinel.
 * Writes `layer.data` only; the caller flushes.
 */
export function clearSelectedPixels(
  layer: Pick<GpuLayer, "data" | "format" | "layerWidth" | "layerHeight" | "offsetX" | "offsetY">,
  mask: Uint8Array,
  canvasWidth: number,
): void {
  const indexed = layer.format === "indexed8";
  const float = layer.format === "rgba32f";
  const data = layer.data;
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i];
    if (!m) continue;
    const cx = i % canvasWidth;
    const cy = (i - cx) / canvasWidth;
    const lx = cx - layer.offsetX;
    const ly = cy - layer.offsetY;
    if (lx < 0 || ly < 0 || lx >= layer.layerWidth || ly >= layer.layerHeight)
      continue;
    const p = ly * layer.layerWidth + lx;
    if (indexed) {
      if (indexedSelected(m)) data[p] = 255;
      continue;
    }
    const ai = p * 4 + 3;
    if (m === 255) {
      data.fill(0, ai - 3, ai + 1);
      continue;
    }
    const a = data[ai] * (1 - m / 255);
    data[ai] = float ? a : Math.round(a);
  }
}
