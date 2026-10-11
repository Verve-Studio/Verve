// ─── Browser image encoders (PNG / JPEG / WebP) ──────────────────────────────
//
// Encodes through an OffscreenCanvas and `convertToBlob`, which is async and
// returns the file bytes directly — no synchronous `toDataURL`, no base64.

/** Encode RGBA pixels with the browser's built-in encoder. When `background`
 *  is set the pixels are composited over it first (formats without alpha). */
export async function encodeWithCanvas(
  pixels: Uint8Array,
  width: number,
  height: number,
  type: "image/png" | "image/jpeg" | "image/webp",
  options: { quality?: number; background?: string } = {},
): Promise<Uint8Array> {
  const image = new ImageData(
    new Uint8ClampedArray(
      pixels.buffer as ArrayBuffer,
      pixels.byteOffset,
      width * height * 4,
    ),
    width,
    height,
  );
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  if (options.background) {
    // putImageData replaces pixels, so composite via a second canvas.
    const src = new OffscreenCanvas(width, height);
    src.getContext("2d")!.putImageData(image, 0, 0);
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(src, 0, 0);
  } else {
    ctx.putImageData(image, 0, 0);
  }
  const blob = await canvas.convertToBlob({ type, quality: options.quality });
  return new Uint8Array(await blob.arrayBuffer());
}
