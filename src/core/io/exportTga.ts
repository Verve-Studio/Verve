// ─── TGA export ───────────────────────────────────────────────────────────────
//
// Writes an uncompressed type-2 TGA (true-color, 32-bit BGRA) with top-left
// origin. The format is lossless and retains the full alpha channel.
// No browser API is needed — the binary is built manually.

/**
 * Encode RGBA pixel data to a TGA data-URL.
 *
 * @param pixels  Raw RGBA bytes, top-row-first.
 * @param width   Image width in pixels.
 * @param height  Image height in pixels.
 * @returns       `data:image/tga;base64,...` string.
 */
export function exportTga(
  pixels: Uint8Array,
  width: number,
  height: number,
): string {
  const HEADER_SIZE = 18;
  const buf = new Uint8Array(HEADER_SIZE + width * height * 4);

  // ── TGA header ────────────────────────────────────────────────────────────
  buf[0] = 0; // ID Length: no image ID
  buf[1] = 0; // Color Map Type: none
  buf[2] = 2; // Image Type: uncompressed true-color
  // Bytes 3–7: Color Map Specification (all zero — unused)
  buf[8] = 0; // X Origin (lo)
  buf[9] = 0; // X Origin (hi)
  buf[10] = 0; // Y Origin (lo)
  buf[11] = 0; // Y Origin (hi)
  buf[12] = width & 0xff; // Width  (lo)
  buf[13] = (width >> 8) & 0xff; // Width  (hi)
  buf[14] = height & 0xff; // Height (lo)
  buf[15] = (height >> 8) & 0xff; // Height (hi)
  buf[16] = 32; // Pixel Depth: 32-bit BGRA
  // Image Descriptor: bit 5 = 1 (top-left origin), bits 0–3 = 8 (alpha bits)
  buf[17] = 0x28;

  // ── Pixel data: RGBA → BGRA ───────────────────────────────────────────────
  let out = HEADER_SIZE;
  for (let i = 0; i < pixels.length; i += 4) {
    buf[out++] = pixels[i + 2]; // B
    buf[out++] = pixels[i + 1]; // G
    buf[out++] = pixels[i + 0]; // R
    buf[out++] = pixels[i + 3]; // A
  }

  // ── Encode to base64 (chunked to avoid call-stack limits) ─────────────────
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...buf.subarray(i, Math.min(i + CHUNK, buf.length)),
    );
  }
  return `data:image/tga;base64,${btoa(binary)}`;
}
