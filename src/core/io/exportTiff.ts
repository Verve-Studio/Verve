// ─── TIFF export ──────────────────────────────────────────────────────────────
//
// Lossless, retains the full alpha channel. Uses UTIF.encodeImage which writes
// an uncompressed TIFF. No browser API needed. An embedded ICC profile is
// added by appending tag 34675 to the IFD post-encode (UTIF.encodeImage
// doesn't surface custom tags).

import * as UTIF from "utif";
import { embedIccInTiff } from "@/core/cms/iccProfile";

export interface TiffExportOptions {
  /** Raw ICC profile bytes to embed as tag 34675 (ICCProfile). */
  iccProfile?: Uint8Array;
}

/**
 * Encode RGBA pixel data to a TIFF data-URL.
 *
 * @param pixels  Raw RGBA bytes, top-row-first.
 * @param width   Image width in pixels.
 * @param height  Image height in pixels.
 * @returns       `data:image/tiff;base64,...` string.
 */
export function exportTiff(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: TiffExportOptions = {},
): string {
  const buffer = UTIF.encodeImage(pixels, width, height);
  const encoded = new Uint8Array(buffer);
  const bytes: Uint8Array = options.iccProfile
    ? embedIccInTiff(encoded, options.iccProfile)
    : encoded;
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return `data:image/tiff;base64,${btoa(binary)}`;
}
