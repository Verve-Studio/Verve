/**
 * GPU buffer readback rows are aligned to a 256-byte boundary, so each row
 * has up to 252 bytes of trailing padding past the actual pixel data. These
 * helpers strip the padding and return a tightly-packed buffer suitable for
 * passing back to e.g. canvas.toDataURL or CPU pixel processing.
 */

/** Strip per-row alignment padding from a uint8 RGBA readback. */
export function unpackRows(
  src: Uint8Array,
  w: number,
  h: number,
  alignedBpr: number,
): Uint8Array {
  const packedBpr = w * 4;
  if (alignedBpr === packedBpr) return src.slice();
  const out = new Uint8Array(packedBpr * h);
  for (let row = 0; row < h; row++) {
    out.set(
      src.subarray(row * alignedBpr, row * alignedBpr + packedBpr),
      row * packedBpr,
    );
  }
  return out;
}

/** Strip per-row alignment padding from a float32 RGBA readback. */
export function unpackF32Rows(
  src: Float32Array,
  w: number,
  h: number,
  alignedStride: number,
): Float32Array {
  const packedStride = w * 4;
  if (alignedStride === packedStride) return src.slice();
  const out = new Float32Array(packedStride * h);
  for (let row = 0; row < h; row++) {
    out.set(
      src.subarray(row * alignedStride, row * alignedStride + packedStride),
      row * packedStride,
    );
  }
  return out;
}
