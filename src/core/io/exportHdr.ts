import { encodeRgbe } from './hdrCodec'

export function exportHdr(pixels: Float32Array, width: number, height: number): Uint8Array {
  return encodeRgbe(pixels, width, height)
}
