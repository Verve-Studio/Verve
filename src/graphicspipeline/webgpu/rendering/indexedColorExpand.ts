import type { RGBAColor } from "@/types";

/**
 * Expand an indexed8 layer's palette indices into a packed RGBA8 buffer ready
 * for GPU upload. Indices outside the palette range render transparent — this
 * matches the indexed8 convention where 255 acts as a transparent sentinel.
 */
export function expandIndicesToRgba8(
  indices: Uint8Array,
  palette: readonly RGBAColor[],
): Uint8Array {
  const out = new Uint8Array(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (idx < palette.length) {
      const c = palette[idx];
      out[i * 4] = c.r;
      out[i * 4 + 1] = c.g;
      out[i * 4 + 2] = c.b;
      out[i * 4 + 3] = c.a;
    }
    // else: idx >= palette.length → [0,0,0,0] (already zero from new Uint8Array)
  }
  return out;
}
