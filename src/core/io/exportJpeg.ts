// ─── JPEG export ──────────────────────────────────────────────────────────────
//
// JPEG does not support transparency. Any alpha channel in the source pixels
// is composited over a solid background colour before encoding.
// Quality ranges from 0 (worst) to 100 (best); the canvas API uses 0–1.
// An embedded ICC profile is added post-encode via APP2 markers — the
// browser's encoder doesn't accept profile bytes directly.

import { embedIccInJpeg } from "@/core/cms/iccProfile";

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
 * Encode RGBA pixel data to a JPEG data-URL.
 *
 * Transparent pixels are composited over `options.background` because JPEG
 * has no alpha channel.
 *
 * @param pixels  Raw RGBA bytes, top-row-first.
 * @param width   Image width in pixels.
 * @param height  Image height in pixels.
 * @param options JPEG-specific compression options.
 * @returns       `data:image/jpeg;base64,...` string.
 */
export function exportJpeg(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: JpegExportOptions = { quality: 92, background: "#ffffff" },
): string {
  // Draw RGBA pixels onto an intermediate canvas so that semi-transparent
  // areas are preserved before compositing.
  const src = document.createElement("canvas");
  src.width = width;
  src.height = height;
  const srcCtx = src.getContext("2d")!;
  srcCtx.putImageData(
    new ImageData(
      new Uint8ClampedArray(pixels.buffer as ArrayBuffer),
      width,
      height,
    ),
    0,
    0,
  );

  // Composite over the chosen background using standard alpha blending.
  const dst = document.createElement("canvas");
  dst.width = width;
  dst.height = height;
  const dstCtx = dst.getContext("2d")!;
  dstCtx.fillStyle = options.background;
  dstCtx.fillRect(0, 0, width, height);
  dstCtx.drawImage(src, 0, 0);

  const quality = Math.max(0, Math.min(100, options.quality)) / 100;
  const dataUrl = dst.toDataURL("image/jpeg", quality);
  if (!options.iccProfile) return dataUrl;

  // Inject APP2 ICC profile segments into the browser-encoded JPEG.
  const base64 = dataUrl.slice("data:image/jpeg;base64,".length);
  const bin = atob(base64);
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  const withProfile = embedIccInJpeg(raw, options.iccProfile);
  let str = "";
  const CHUNK = 65536;
  for (let i = 0; i < withProfile.length; i += CHUNK) {
    str += String.fromCharCode(
      ...withProfile.subarray(i, Math.min(i + CHUNK, withProfile.length)),
    );
  }
  return `data:image/jpeg;base64,${btoa(str)}`;
}
