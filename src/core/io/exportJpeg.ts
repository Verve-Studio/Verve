// ─── JPEG export ──────────────────────────────────────────────────────────────
//
// JPEG does not support transparency. Any alpha channel in the source pixels
// is composited over a solid background colour before encoding.
// Quality ranges from 0 (worst) to 100 (best); the canvas API uses 0–1.
// An embedded ICC profile is added post-encode via APP2 markers — the
// browser's encoder doesn't accept profile bytes directly.

import { embedIccInJpeg } from "@/core/cms/iccProfile";
import { encodeWithCanvas } from "./canvasEncode";

export interface JpegExportOptions {
  /**
   * Encode quality in the 0–100 range (maps to 0.0–1.0 internally).
   * Default: 92.
   */
  quality: number;
  /**
   * CSS colour used as the background for transparent/semi-transparent pixels.
   * Default: '#ffffff'.
   */
  background: string;
  /** Raw ICC profile bytes to embed as APP2 marker(s). */
  iccProfile?: Uint8Array;
}

/**
 * Encode RGBA pixel data as a JPEG file.
 *
 * Transparent pixels are composited over `options.background` because JPEG
 * has no alpha channel.
 *
 * @param pixels  Raw RGBA bytes, top-row-first.
 * @param width   Image width in pixels.
 * @param height  Image height in pixels.
 * @param options JPEG-specific compression options.
 * @returns       The JPEG file bytes.
 */
export async function exportJpeg(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: JpegExportOptions = { quality: 92, background: "#ffffff" },
): Promise<Uint8Array> {
  const quality = Math.max(0, Math.min(100, options.quality)) / 100;
  const jpeg = await encodeWithCanvas(pixels, width, height, "image/jpeg", {
    quality,
    background: options.background,
  });
  return options.iccProfile ? embedIccInJpeg(jpeg, options.iccProfile) : jpeg;
}
