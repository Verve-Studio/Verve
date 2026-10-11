// ─── PNG export ───────────────────────────────────────────────────────────────
//
// PNG is lossless. The HTML5 canvas API does not expose compression-level
// controls at encode time; the browser selects an appropriate level internally.
// An embedded ICC profile is added post-encode by injecting an `iCCP` chunk
// — the browser's encoder doesn't accept profile bytes directly.

import { embedIccInPng } from "@/core/cms/iccProfile";
import { encodeWithCanvas } from "./canvasEncode";

export interface PngExportOptions {
  /** Raw ICC profile bytes to embed as an `iCCP` chunk. */
  iccProfile?: Uint8Array;
}

/**
 * Encode RGBA pixel data as a PNG file.
 *
 * @param pixels  Raw RGBA bytes, top-row-first.
 * @param width   Image width in pixels.
 * @param height  Image height in pixels.
 * @returns       The PNG file bytes.
 */
export async function exportPng(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: PngExportOptions = {},
): Promise<Uint8Array> {
  const png = await encodeWithCanvas(pixels, width, height, "image/png");
  return options.iccProfile ? embedIccInPng(png, options.iccProfile) : png;
}
