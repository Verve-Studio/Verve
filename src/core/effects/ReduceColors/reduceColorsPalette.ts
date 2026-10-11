/**
 * "Reduce to N" palette for the Reduce Colors effect: quantize the pixels
 * feeding the effect. Shared by the panel (debounced on edits) and headless
 * creation (automation).
 */
import type { RGBAColor } from "@/types";
import { linearToSrgbChannel } from "@/utils/pixelFormatConvert";
import { quantizeOffThread } from "@/wasm/pixelopsWorkerClient";

const QUANTIZE_SAMPLE_PIXELS = 1_000_000;

/** Even subsample of `native` (RGBA) as sRGB bytes for the quantizer. */
function samplePixelsForQuantize(
  native: Uint8Array | Float32Array,
): Uint8Array {
  const count = native.length / 4;
  const stride = Math.max(1, Math.ceil(count / QUANTIZE_SAMPLE_PIXELS));
  const out = new Uint8Array(Math.ceil(count / stride) * 4);
  const isFloat = native instanceof Float32Array;
  let o = 0;
  for (let p = 0; p < count; p += stride, o += 4) {
    const i = p * 4;
    if (isFloat) {
      for (let c = 0; c < 3; c++) {
        const e = linearToSrgbChannel(native[i + c]);
        out[o + c] = e <= 0 ? 0 : e >= 1 ? 255 : Math.round(e * 255);
      }
      const a = native[i + 3];
      out[o + 3] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
    } else {
      out[o] = native[i];
      out[o + 1] = native[i + 1];
      out[o + 2] = native[i + 2];
      out[o + 3] = native[i + 3];
    }
  }
  return out;
}

/** Quantize `native` (RGBA; rgba32f input is scene-linear) to at most
 *  `colorCount` colours. */
export async function computeReducedPalette(
  native: Uint8Array | Float32Array,
  colorCount: number,
): Promise<RGBAColor[]> {
  // Palette statistics don't need every pixel: quantize an even subsample
  // of at most QUANTIZE_SAMPLE_PIXELS. rgba32f input is scene-linear, so
  // it's gamma-encoded to sRGB bytes (the quantizer and the palette are
  // sRGB), not scaled by 255.
  const result = await quantizeOffThread(samplePixelsForQuantize(native), colorCount);
  const palette: RGBAColor[] = [];
  for (let i = 0; i < result.count; i++) {
    palette.push({
      r: result.palette[i * 4 + 0],
      g: result.palette[i * 4 + 1],
      b: result.palette[i * 4 + 2],
      a: result.palette[i * 4 + 3],
    });
  }
  return palette;
}
