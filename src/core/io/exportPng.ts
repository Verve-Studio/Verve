// ─── PNG export ───────────────────────────────────────────────────────────────
//
// PNG is lossless. The HTML5 canvas API does not expose compression-level
// controls at encode time; the browser selects an appropriate level internally.
// No lossy parameters means no additional options for this format.

export interface PngExportOptions {
  // reserved for future parameters (e.g. metadata)
}

/**
 * Encode RGBA pixel data to a PNG data-URL.
 *
 * @param pixels  Raw RGBA bytes, top-row-first.
 * @param width   Image width in pixels.
 * @param height  Image height in pixels.
 * @returns       `data:image/png;base64,...` string.
 */
export function exportPng(
  pixels: Uint8Array,
  width: number,
  height: number,
  _options: PngExportOptions = {},
): string {
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
  return tmp.toDataURL("image/png");
}
