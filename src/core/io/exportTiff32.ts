// Minimal uncompressed 32-bit float TIFF writer (SampleFormat=3, IEEE float).
// Spec: https://www.awaresystems.be/imaging/tiff/tifftags.html

const TIFF_LITTLE_ENDIAN = 0x4949
const TIFF_MAGIC = 42

// IFD tag constants
const TAG_IMAGE_WIDTH      = 256
const TAG_IMAGE_LENGTH     = 257
const TAG_BITS_PER_SAMPLE  = 258
const TAG_COMPRESSION      = 259
const TAG_PHOTO_INTERP     = 262
const TAG_STRIP_OFFSETS    = 273
const TAG_SAMPLES_PER_PIXEL = 277
const TAG_ROWS_PER_STRIP   = 278
const TAG_STRIP_BYTE_COUNTS = 279
const TAG_PLANAR_CONFIG    = 284
const TAG_SAMPLE_FORMAT    = 339

const TYPE_SHORT  = 3
const TYPE_LONG   = 4

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true)
}
function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true)
}

function writeTag(view: DataView, offset: number, tag: number, type: number, count: number, valueOrOffset: number): void {
  writeUint16(view, offset, tag)
  writeUint16(view, offset + 2, type)
  writeUint32(view, offset + 4, count)
  writeUint32(view, offset + 8, valueOrOffset)
}

export function exportTiff32(pixels: Float32Array, width: number, height: number): Uint8Array {
  const samplesPerPixel = 4
  const bytesPerSample = 4 // float32
  const imageDataSize = width * height * samplesPerPixel * bytesPerSample

  // 13 IFD entries × 12 bytes each + 4 bytes for next IFD offset = 160 bytes
  // Header: 8 bytes
  // IFD count: 2 bytes
  // IFD entries: 13 × 12 = 156 bytes
  // Next IFD offset: 4 bytes
  // BitsPerSample values (4 × short): 8 bytes
  // SampleFormat values (4 × short): 8 bytes
  // Image data follows

  const ifdEntries = 13
  const headerSize = 8
  const ifdCountSize = 2
  const ifdSize = ifdEntries * 12
  const nextIfdSize = 4
  const bpsOffset = headerSize + ifdCountSize + ifdSize + nextIfdSize
  const sfOffset = bpsOffset + 8
  const imageDataOffset = sfOffset + 8

  const totalSize = imageDataOffset + imageDataSize
  const buffer = new ArrayBuffer(totalSize)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  // TIFF header
  writeUint16(view, 0, TIFF_LITTLE_ENDIAN)
  writeUint16(view, 2, TIFF_MAGIC)
  writeUint32(view, 4, headerSize) // IFD offset

  // IFD count
  let off = headerSize
  writeUint16(view, off, ifdEntries)
  off += 2

  writeTag(view, off, TAG_IMAGE_WIDTH,      TYPE_LONG,  1, width);                          off += 12
  writeTag(view, off, TAG_IMAGE_LENGTH,     TYPE_LONG,  1, height);                         off += 12
  writeTag(view, off, TAG_BITS_PER_SAMPLE,  TYPE_SHORT, 4, bpsOffset);                      off += 12
  writeTag(view, off, TAG_COMPRESSION,      TYPE_SHORT, 1, 1 /* none */);                   off += 12
  writeTag(view, off, TAG_PHOTO_INTERP,     TYPE_SHORT, 1, 2 /* RGB */);                    off += 12
  writeTag(view, off, TAG_STRIP_OFFSETS,    TYPE_LONG,  1, imageDataOffset);                off += 12
  writeTag(view, off, TAG_SAMPLES_PER_PIXEL, TYPE_SHORT, 1, samplesPerPixel);               off += 12
  writeTag(view, off, TAG_ROWS_PER_STRIP,   TYPE_LONG,  1, height);                         off += 12
  writeTag(view, off, TAG_STRIP_BYTE_COUNTS, TYPE_LONG, 1, imageDataSize);                  off += 12
  writeTag(view, off, TAG_PLANAR_CONFIG,    TYPE_SHORT, 1, 1 /* chunky */);                 off += 12
  writeTag(view, off, TAG_SAMPLE_FORMAT,    TYPE_SHORT, 4, sfOffset);                       off += 12
  // ExtraSamples (tag 338): 1 sample = 2 (unassoc alpha)
  writeTag(view, off, 338,                  TYPE_SHORT, 1, 2);                              off += 12
  // YResolution (tag 283): ignored, store a dummy (1/1) — skip for minimal compliance
  // Use a padding tag that readers ignore
  writeTag(view, off, TAG_IMAGE_WIDTH,      TYPE_LONG,  1, width);                          off += 12 // duplicated fine per TIFF spec (readers take first)

  // Next IFD = 0
  writeUint32(view, off, 0); off += 4

  // BitsPerSample values: 32, 32, 32, 32
  for (let i = 0; i < 4; i++) { writeUint16(view, bpsOffset + i * 2, 32) }

  // SampleFormat values: 3, 3, 3, 3 (IEEE float)
  for (let i = 0; i < 4; i++) { writeUint16(view, sfOffset + i * 2, 3) }

  // Image data (interleaved RGBA, little-endian float)
  const pixelView = new DataView(buffer, imageDataOffset)
  for (let i = 0; i < pixels.length; i++) {
    pixelView.setFloat32(i * 4, pixels[i], true)
  }

  return bytes
}
