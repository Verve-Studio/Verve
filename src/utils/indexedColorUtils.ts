import type { GpuLayer } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import type { RGBAColor } from "@/types";

// ─── Palette resolution ───────────────────────────────────────────────────────

/**
 * Find the palette index with the smallest RGBA Euclidean distance to (r,g,b,a).
 * Returns 255 if the palette is empty.
 * On a tie in distance, the lower index wins.
 */
export function resolveNearestPaletteIndex(
  r: number,
  g: number,
  b: number,
  a: number,
  palette: readonly RGBAColor[],
): number {
  if (palette.length === 0) return 255;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = r - p.r;
    const dg = g - p.g;
    const db = b - p.b;
    const da = a - p.a;
    const dist = dr * dr + dg * dg + db * db + da * da;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ─── Pixel write helpers ──────────────────────────────────────────────────────

/**
 * Write a single palette index into layer.data at the given canvas coordinate.
 * Applies selection mask and tiled-mode wrapping.
 * Returns true if the write was performed, false if gated out.
 */
export function writeIndexToLayer(
  layer: GpuLayer,
  canvasX: number,
  canvasY: number,
  index: number,
  sel?: { mask: Uint8Array; width: number },
  tiledW?: number,
  tiledH?: number,
): boolean {
  if (tiledW !== undefined && tiledH !== undefined) {
    canvasX = ((canvasX % tiledW) + tiledW) % tiledW;
    canvasY = ((canvasY % tiledH) + tiledH) % tiledH;
  }
  if (canvasX < 0 || canvasY < 0) return false;
  if (sel && sel.mask[canvasY * sel.width + canvasX] === 0) return false;
  const lx = canvasX - layer.offsetX;
  const ly = canvasY - layer.offsetY;
  if (lx < 0 || lx >= layer.layerWidth || ly < 0 || ly >= layer.layerHeight)
    return false;
  (layer.data as Uint8Array)[ly * layer.layerWidth + lx] = index;
  return true;
}

/**
 * Stamp a size×size footprint at canvas (cx, cy) using the given shape.
 * Calls writeIndexToLayer for each pixel inside the shape boundary.
 * Write-once semantics: each canvas pixel is written at most once per stroke
 * (tracked via the `touched` map; key = canvasY * canvasWidth + canvasX, but
 * since we don't have canvasWidth here, key = canvasY * 65536 + canvasX which
 * is sufficient for typical canvas sizes ≤ 65535).
 */
export function stampIndexedShape(
  layer: GpuLayer,
  cx: number,
  cy: number,
  index: number,
  size: number,
  shape: "round" | "square" | "diamond",
  touched: Map<number, true>,
  sel?: { mask: Uint8Array; width: number },
  tiledW?: number,
  tiledH?: number,
): void {
  const half = (size - 1) / 2;
  const x0 = Math.floor(cx - half);
  const x1 = Math.floor(cx + half);
  const y0 = Math.floor(cy - half);
  const y1 = Math.floor(cy + half);

  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      let inside = false;
      if (shape === "square") {
        inside = true;
      } else if (shape === "round") {
        const dx = px - cx + 0.5,
          dy = py - cy + 0.5;
        inside = dx * dx + dy * dy <= half * half + half + 0.25;
      } else {
        // diamond: Manhattan distance
        const dx = Math.abs(px - cx + 0.5),
          dy = Math.abs(py - cy + 0.5);
        inside = dx + dy <= half + 0.5;
      }
      if (!inside) continue;

      let tx = px,
        ty = py;
      if (tiledW !== undefined && tiledH !== undefined) {
        tx = ((tx % tiledW) + tiledW) % tiledW;
        ty = ((ty % tiledH) + tiledH) % tiledH;
      }
      const key = ty * 65536 + tx;
      if (touched.has(key)) continue;
      if (writeIndexToLayer(layer, px, py, index, sel, tiledW, tiledH)) {
        touched.set(key, true);
      }
    }
  }
}

// ─── Format conversion ────────────────────────────────────────────────────────

/**
 * Expand a 1-byte-per-pixel indexed Uint8Array into a 4-byte-per-pixel RGBA buffer.
 * Out-of-range indices and 255 map to [0,0,0,0].
 */
export function expandIndicesToRgba(
  indexData: Uint8Array,
  palette: readonly RGBAColor[],
): Uint8Array {
  const out = new Uint8Array(indexData.length * 4);
  for (let i = 0; i < indexData.length; i++) {
    const idx = indexData[i];
    if (idx < palette.length) {
      const p = palette[idx];
      const di = i * 4;
      out[di] = p.r;
      out[di + 1] = p.g;
      out[di + 2] = p.b;
      out[di + 3] = p.a;
    }
    // else: leaves [0,0,0,0] — transparent for void/out-of-range
  }
  return out;
}
