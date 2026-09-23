import { srgbToLinearChannel } from "@/utils/pixelFormatConvert";

/** True for render targets that hold scene-linear light (rgba16f/32f docs). */
export function isLinearTarget(format: GPUTextureFormat): boolean {
  return format === "rgba16float" || format === "rgba32float";
}

/**
 * A user-picked colour (sRGB-encoded 0–255 channels) as normalised floats in
 * the colour space of `format`: sRGB/255 for 8-bit targets, gamma-decoded
 * for linear ones. Alpha is linear in both.
 */
export function colorForTarget(
  c: { r: number; g: number; b: number; a: number },
  format: GPUTextureFormat,
): { r: number; g: number; b: number; a: number } {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const a = c.a / 255;
  if (!isLinearTarget(format)) return { r, g, b, a };
  return {
    r: srgbToLinearChannel(r),
    g: srgbToLinearChannel(g),
    b: srgbToLinearChannel(b),
    a,
  };
}
