// ─── TIFF export ──────────────────────────────────────────────────────────────
//
// Lossless, retains the full alpha channel. Uses UTIF.encodeImage which writes
// an uncompressed TIFF. No browser API needed.

import * as UTIF from "utif";

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
): string {
  const buffer = UTIF.encodeImage(pixels, width, height);
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return `data:image/tiff;base64,${btoa(binary)}`;
}
