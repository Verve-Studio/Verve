import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import type { RGBAColor } from "@/types";
import {
  footprintCentreOffset,
  footprintStart,
  inPencilFootprint,
} from "@/core/tools/Pencil/pencilFootprint";

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
  if (sel) {
    // Bounds first: a layer can extend past the canvas, and an unchecked
    // index read the next row (or undefined → bypassing the selection).
    if (canvasX >= sel.width) return false;
    const si = canvasY * sel.width + canvasX;
    if (si >= sel.mask.length || sel.mask[si] === 0) return false;
  }
  const lx = canvasX - layer.offsetX;
  const ly = canvasY - layer.offsetY;
  if (lx < 0 || lx >= layer.layerWidth || ly < 0 || ly >= layer.layerHeight)
    return false;
  (layer.data as Uint8Array)[ly * layer.layerWidth + lx] = index;
  return true;
}

/**
 * Stamp a size×size footprint at canvas (cx, cy) using the given shape — the
 * shared pencil footprint rule (see `pencilFootprint.ts`), identical to the
 * cursor preview. Writing an index is idempotent, so overlapping stamps need
 * no per-stroke coverage tracking.
 */
export function stampIndexedShape(
  layer: GpuLayer,
  cx: number,
  cy: number,
  index: number,
  size: number,
  shape: "round" | "square" | "diamond",
  sel?: { mask: Uint8Array; width: number },
  tiledW?: number,
  tiledH?: number,
): void {
  const n = Math.max(1, Math.round(size));
  const start = footprintStart(n);
  const centre = footprintCentreOffset(n);
  for (let j = 0; j < n; j++) {
    const oy = start + j - centre;
    for (let i = 0; i < n; i++) {
      const ox = start + i - centre;
      if (!inPencilFootprint(ox, oy, n, shape)) continue;
      writeIndexToLayer(layer, cx + start + i, cy + start + j, index, sel, tiledW, tiledH);
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
