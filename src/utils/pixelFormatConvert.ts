/** Convert an RGBA8 Uint8Array to a Float32Array by dividing each channel by 255. */
export function convertRgba8ToF32(src: Uint8Array): Float32Array {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) {
    out[i] = src[i] / 255
  }
  return out
}

/** Convert a Float32Array (rgba32f) to RGBA8 Uint8Array by clamping to [0,1] then scaling. */
export function convertF32ToRgba8(src: Float32Array): Uint8Array {
  const out = new Uint8Array(src.length)
  for (let i = 0; i < src.length; i++) {
    out[i] = Math.round(Math.max(0, Math.min(1, src[i])) * 255)
  }
  return out
}

/** Expand an indexed8 Uint8Array to RGBA8 by looking up each index in the palette. */
export function convertIndexedToRgba8(
  src: Uint8Array,
  palette: Array<{ r: number; g: number; b: number; a: number }>,
): Uint8Array {
  const out = new Uint8Array(src.length * 4)
  for (let i = 0; i < src.length; i++) {
    const entry = palette[src[i]]
    if (entry) {
      out[i * 4]     = entry.r
      out[i * 4 + 1] = entry.g
      out[i * 4 + 2] = entry.b
      out[i * 4 + 3] = entry.a
    }
  }
  return out
}

/** Clamp a Float32Array (rgba32f) to RGBA8 Uint8Array. Alias of convertF32ToRgba8. */
export function clampF32ToUint8(src: Float32Array): Uint8Array {
  return convertF32ToRgba8(src)
}

/** Expand an indexed8 Uint8Array to Float32Array (rgba32f) via palette lookup then normalisation. */
export function convertIndexedToF32(
  src: Uint8Array,
  palette: Array<{ r: number; g: number; b: number; a: number }>,
): Float32Array {
  return convertRgba8ToF32(convertIndexedToRgba8(src, palette))
}
