// ─── WebP export ──────────────────────────────────────────────────────────────
//
// WebP supports transparency natively, so no background compositing is needed.
// Quality ranges from 0 (worst / smallest) to 100 (best / largest).
// Chromium's canvas encoder supports it (OffscreenCanvas.convertToBlob).

import { encodeWithCanvas } from "./canvasEncode";

export interface WebpExportOptions {
  quality: number; // 0–100, maps to 0.0–1.0 internally. Default: 90.
}

/** Encode RGBA pixel data as a WebP file; returns the file bytes. */
export function exportWebp(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: WebpExportOptions = { quality: 90 },
): Promise<Uint8Array> {
  const quality = Math.max(0, Math.min(100, options.quality)) / 100;
  return encodeWithCanvas(pixels, width, height, "image/webp", { quality });
}
