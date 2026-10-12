// ─── PNG export ───────────────────────────────────────────────────────────────
//
// PNG is lossless: pixels are encoded directly (pngCodec.ts), not through a
// 2D canvas, whose premultiplied alpha would alter semi-transparent pixels.
// An ICC profile is embedded as an `iCCP` chunk.

import { encodePng } from "./pngCodec";

export interface PngExportOptions {
  /** Raw ICC profile bytes to embed as an `iCCP` chunk. */
  iccProfile?: Uint8Array;
}

/**
 * Encode RGBA pixel data as a PNG file.
 *
 * @param pixels  Raw straight-alpha RGBA bytes, top-row-first.
 * @param width   Image width in pixels.
 * @param height  Image height in pixels.
 * @returns       The PNG file bytes.
 */
export function exportPng(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: PngExportOptions = {},
): Promise<Uint8Array> {
  return encodePng(pixels, width, height, { iccProfile: options.iccProfile });
}
