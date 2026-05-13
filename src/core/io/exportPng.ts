// ─── PNG export ───────────────────────────────────────────────────────────────
//
// PNG is lossless. The HTML5 canvas API does not expose compression-level
// controls at encode time; the browser selects an appropriate level internally.
// An embedded ICC profile is added post-encode by injecting an `iCCP` chunk
// — the browser's encoder doesn't accept profile bytes directly.

import { embedIccInPng } from "@/core/cms/iccProfile";

export interface PngExportOptions {
  /** Raw ICC profile bytes to embed as an `iCCP` chunk. */
  iccProfile?: Uint8Array;
}

/**
 * Encode RGBA pixel data to a PNG data-URL.
 *
 * @param pixels  Raw RGBA bytes, top-row-first.
 * @param width   Image width in pixels.
 * @param height  Image height in pixels.
 * @returns       `data:image/png;base64,...` string.
 */
export async function exportPng(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: PngExportOptions = {},
): Promise<string> {
  const tmp = document.createElement("canvas");
  tmp.width = width;
  tmp.height = height;
  const ctx = tmp.getContext("2d")!;
  ctx.putImageData(
    new ImageData(
      new Uint8ClampedArray(pixels.buffer as ArrayBuffer),
      width,
      height,
    ),
    0,
    0,
  );
  const dataUrl = tmp.toDataURL("image/png");
  if (!options.iccProfile) return dataUrl;

  // Inject the iCCP chunk into the browser-encoded PNG bytes.
  const base64 = dataUrl.slice("data:image/png;base64,".length);
  const bin = atob(base64);
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  const withProfile = await embedIccInPng(raw, options.iccProfile);
  let str = "";
  const CHUNK = 65536;
  for (let i = 0; i < withProfile.length; i += CHUNK) {
    str += String.fromCharCode(
      ...withProfile.subarray(i, Math.min(i + CHUNK, withProfile.length)),
    );
  }
  return `data:image/png;base64,${btoa(str)}`;
}
