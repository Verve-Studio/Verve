// ─── WebP export ──────────────────────────────────────────────────────────────
//
// WebP supports transparency natively, so no background compositing is needed.
// Quality ranges from 0 (worst / smallest) to 100 (best / largest).
// Chromium exposes this via canvas.toDataURL('image/webp', quality).

export interface WebpExportOptions {
  quality: number; // 0–100, maps to 0.0–1.0 internally. Default: 90.
}

export function exportWebp(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: WebpExportOptions = { quality: 90 },
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
  const quality = Math.max(0, Math.min(100, options.quality)) / 100;
  return tmp.toDataURL("image/webp", quality);
}
