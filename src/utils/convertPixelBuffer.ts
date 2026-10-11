import type { LayerColorSpace, PixelFormat, RGBAColor } from "@/types";
import {
  convertRgba8ToF32,
  convertRgba8ToF32Raw,
  convertF32ToRgba8,
  convertIndexedToRgba8,
  convertIndexedToF32,
} from "@/utils/pixelFormatConvert";
import { matchPaletteIndices } from "@/wasm";

/** Convert raw pixel data from one format to another. For `rgba8 → rgba32f`
 *  the result is **scene-linear** floats (CLAUDE.md's "rgba32f = linear
 *  light" rule). When `sourceColorSpace` is `'auto'` / `'srgb'` / undefined
 *  we apply the sRGB transfer function so the float buffer matches what
 *  lcms2's working profile, Convert to Profile, and file I/O all assume.
 *  For log / linear / wide-gamut sources we keep a non-destructive `/255`
 *  promotion — those signals don't carry the sRGB curve and the renderer's
 *  inline IDT pre-pass decodes them at composite time via the layer's
 *  `colorSpace` tag. */
export async function convertPixelBuffer(
  data: Uint8Array | Float32Array,
  fromFormat: PixelFormat,
  toFormat: PixelFormat,
  palette: RGBAColor[],
  sourceColorSpace?: LayerColorSpace,
): Promise<Uint8Array | Float32Array> {
  if (fromFormat === toFormat) return data;

  if (fromFormat === "rgba8" && toFormat === "rgba32f") {
    const isSrgbSource =
      sourceColorSpace === undefined ||
      sourceColorSpace === "auto" ||
      sourceColorSpace === "srgb";
    return isSrgbSource
      ? convertRgba8ToF32(data as Uint8Array)
      : convertRgba8ToF32Raw(data as Uint8Array);
  }
  if (fromFormat === "rgba32f" && toFormat === "rgba8") {
    return convertF32ToRgba8(data as Float32Array);
  }
  if (fromFormat === "rgba8" && toFormat === "indexed8") {
    return matchPaletteIndices(data as Uint8Array, palette);
  }
  if (fromFormat === "indexed8" && toFormat === "rgba8") {
    return convertIndexedToRgba8(data as Uint8Array, palette);
  }
  if (fromFormat === "rgba32f" && toFormat === "indexed8") {
    const rgba8 = convertF32ToRgba8(data as Float32Array);
    return matchPaletteIndices(rgba8, palette);
  }
  if (fromFormat === "indexed8" && toFormat === "rgba32f") {
    return convertIndexedToF32(data as Uint8Array, palette);
  }
  return data;
}
