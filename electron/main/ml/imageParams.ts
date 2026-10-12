/**
 * Validation of image parameters the renderer sends to the ML jobs. The
 * values arrive over IPC, so their types are not guaranteed: a length check
 * alone lets e.g. -1 × -1 with a 4-byte buffer through. Pure (no Electron),
 * so the model cores in the ML worker can use it.
 */

/** Largest accepted side of an image handed to a model, in pixels. */
export const MAX_ML_IMAGE_DIM = 32768

export function isImageDim(v: unknown, max = MAX_ML_IMAGE_DIM): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max
}

/** Throws unless width and height are whole numbers in 1…`max`. */
export function assertImageSize(width: unknown, height: unknown, max = MAX_ML_IMAGE_DIM): void {
  if (!isImageDim(width, max) || !isImageDim(height, max)) {
    throw new Error(
      `Invalid image size ${String(width)}×${String(height)} ` +
        `(each side must be a whole number between 1 and ${max})`,
    )
  }
}

/** Throws unless `buf` is a Uint8Array of exactly `channels` bytes per
 *  pixel of a `width`×`height` image (size already validated). */
export function assertPixelBuffer(
  name: string,
  buf: unknown,
  width: number,
  height: number,
  channels: number,
): asserts buf is Uint8Array {
  if (!(buf instanceof Uint8Array)) throw new Error(`${name} must be a Uint8Array`)
  const expected = width * height * channels
  if (buf.length !== expected) {
    const dims = channels === 1 ? `${width}×${height}` : `${width}×${height}×${channels}`
    throw new Error(`${name} length ${buf.length} ≠ ${dims}`)
  }
}
