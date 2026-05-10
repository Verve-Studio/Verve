// ─── Pixel format conversion ─────────────────────────────────────────────────
//
// Convention (matches industry standards — Photoshop 32-bit, Krita scene-
// linear, OpenEXR, GPU rendering pipelines):
//
//   - rgba8 layers store **sRGB-encoded** byte values (0–255 per channel).
//   - rgba32f layers store **linear-light** float values (0.0 = black,
//     1.0 = display white, > 1 = HDR highlights).
//
// Conversion between the two formats applies the sRGB transfer function:
// sRGB → linear on decode, linear → sRGB on encode. Alpha channels are
// linear in both formats and convert by /255 ↔ *255 only.
//
// This convention makes compositing math (alpha blend, gradient
// interpolation, Gaussian blur, etc.) physically correct: light is additive
// in linear space; in sRGB space those operations produce dark-edge
// artifacts, banded gradients near midtones, and incorrect blur halos.
// Effects, the display tone-mapper, and HDR support all assume linear f32.

/** Standard sRGB → linear-light transfer function (per channel, scalar input
 *  in [0, 1]). Reference: IEC 61966-2-1. The piecewise form avoids the
 *  numerical issues of a pure pow() near zero and matches how GPUs treat
 *  sRGB-tagged textures at sample time. */
export function srgbToLinearChannel(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Inverse of `srgbToLinearChannel` — linear-light → sRGB-encoded (per
 *  channel, scalar input in [0, ∞)). Values > 1 (HDR) push above the sRGB
 *  range; callers that target an 8-bit destination must clamp before
 *  scaling to bytes. */
export function linearToSrgbChannel(c: number): number {
  if (c <= 0) return 0;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Convert an RGBA8 Uint8Array (sRGB-encoded bytes) to a Float32Array
 *  (linear-light floats). Applies the sRGB transfer function to RGB
 *  channels; alpha is converted with `/255` only (alpha is linear). */
export function convertRgba8ToF32(src: Uint8Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    out[i] = srgbToLinearChannel(src[i] / 255);
    out[i + 1] = srgbToLinearChannel(src[i + 1] / 255);
    out[i + 2] = srgbToLinearChannel(src[i + 2] / 255);
    out[i + 3] = src[i + 3] / 255;
  }
  return out;
}

/** Convert a Float32Array (linear-light) to an RGBA8 Uint8Array (sRGB-
 *  encoded bytes). Applies the sRGB transfer function to RGB channels;
 *  alpha is scaled with `*255` only. Values > 1 are clamped at the sRGB
 *  encode step (HDR highlights collapse to white in 8-bit). */
export function convertF32ToRgba8(src: Float32Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const r = linearToSrgbChannel(src[i]);
    const g = linearToSrgbChannel(src[i + 1]);
    const b = linearToSrgbChannel(src[i + 2]);
    const a = src[i + 3];
    out[i] = Math.round(Math.max(0, Math.min(1, r)) * 255);
    out[i + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
    out[i + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
    out[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
  }
  return out;
}

/** Expand an indexed8 Uint8Array to RGBA8 (sRGB-encoded bytes) via
 *  palette lookup. Palette colours are themselves sRGB. */
export function convertIndexedToRgba8(
  src: Uint8Array,
  palette: Array<{ r: number; g: number; b: number; a: number }>,
): Uint8Array {
  const out = new Uint8Array(src.length * 4);
  for (let i = 0; i < src.length; i++) {
    const entry = palette[src[i]];
    if (entry) {
      out[i * 4] = entry.r;
      out[i * 4 + 1] = entry.g;
      out[i * 4 + 2] = entry.b;
      out[i * 4 + 3] = entry.a;
    }
  }
  return out;
}

/** Linear-light Float32Array → 8-bit sRGB Uint8Array. Same operation as
 *  `convertF32ToRgba8` — kept as a separate name because callsites use it
 *  in "I'm flattening for export to an 8-bit file" contexts where the
 *  intent is "clamp HDR + gamma-encode for display", not "convert layer
 *  format". The behaviour is identical. */
export function clampF32ToUint8(src: Float32Array): Uint8Array {
  return convertF32ToRgba8(src);
}

/** Expand an indexed8 Uint8Array to a Float32Array (linear-light) via
 *  palette lookup + sRGB → linear gamma decode. */
export function convertIndexedToF32(
  src: Uint8Array,
  palette: Array<{ r: number; g: number; b: number; a: number }>,
): Float32Array {
  return convertRgba8ToF32(convertIndexedToRgba8(src, palette));
}
