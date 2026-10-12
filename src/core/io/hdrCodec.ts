// Radiance RGBE (.hdr) encode/decode
// Spec: https://radiance.sourceforge.net/cgi-bin/viewcvs.cgi/ray/src/hd/rhd_sample.c
// Each pixel is stored as 4 bytes: R mantissa, G mantissa, B mantissa, shared exponent.
// The new RLE scanline format stores each component in a separate run.

const HDR_HEADER = "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n";

// ─── Decode ───────────────────────────────────────────────────────────────────

function rgbeToFloat(
  r: number,
  g: number,
  b: number,
  e: number,
): [number, number, number] {
  if (e === 0) return [0, 0, 0];
  const scale = Math.pow(2, e - 128 - 8);
  return [r * scale, g * scale, b * scale];
}

/** True when an RGBE scanline of this width may use the new run-length
 *  format. Narrower or wider scanlines are always flat RGBE pixels. */
function rleWidth(width: number): boolean {
  return width >= 8 && width <= 0x7fff;
}

const truncated = (): Error => new Error("HDR: unexpected end of file (truncated pixel data)");

function decodeScanline(
  data: Uint8Array,
  offset: number,
  width: number,
  scanline: Uint8Array,
): number {
  const end = data.length;
  // New-format RLE scanlines start with [2, 2, hi, lo] (width 8..0x7fff).
  if (
    !rleWidth(width) ||
    offset + 4 > end ||
    data[offset] !== 2 ||
    data[offset + 1] !== 2 ||
    (data[offset + 2] & 0x80) !== 0
  ) {
    // Flat format: raw RGBE pixels.
    const n = width * 4;
    if (offset + n > end) throw truncated();
    scanline.set(data.subarray(offset, offset + n));
    return offset + n;
  }

  const scanlineWidth = (data[offset + 2] << 8) | data[offset + 3];
  if (scanlineWidth !== width) throw new Error("HDR: bad scanline width");
  offset += 4;

  // New RLE: 4 channels decoded separately
  for (let ch = 0; ch < 4; ch++) {
    let idx = 0;
    while (idx < width) {
      if (offset >= end) throw truncated();
      const code = data[offset++];
      if (code > 128) {
        // Run
        const count = code - 128;
        if (idx + count > width) throw new Error("HDR: bad scanline data (run overflows the scanline)");
        if (offset >= end) throw truncated();
        const val = data[offset++];
        for (let i = 0; i < count; i++) scanline[ch + idx++ * 4] = val;
      } else {
        // Non-run
        if (code === 0 || idx + code > width) throw new Error("HDR: bad scanline data");
        if (offset + code > end) throw truncated();
        for (let i = 0; i < code; i++)
          scanline[ch + idx++ * 4] = data[offset++];
      }
    }
  }

  return offset;
}

export function decodeRgbe(bytes: Uint8Array): {
  pixels: Float32Array;
  width: number;
  height: number;
} {
  const text = new TextDecoder("ascii");
  let offset = 0;

  // Parse header
  let headerEnd = 0;
  while (headerEnd < bytes.length - 1) {
    if (bytes[headerEnd] === 0x0a && bytes[headerEnd + 1] === 0x0a) {
      headerEnd += 2;
      break;
    }
    headerEnd++;
  }
  const header = text.decode(bytes.slice(0, headerEnd));
  if (!header.includes("FORMAT=32-bit_rle_rgbe"))
    throw new Error("HDR: unsupported format");
  offset = headerEnd;

  // Parse resolution line: "-Y <height> +X <width>\n"
  let resEnd = offset;
  while (resEnd < bytes.length && bytes[resEnd] !== 0x0a) resEnd++;
  const resLine = text.decode(bytes.slice(offset, resEnd)).trim();
  offset = resEnd + 1;

  const resMatch = resLine.match(/-Y\s+(\d+)\s+\+X\s+(\d+)/);
  if (!resMatch) throw new Error("HDR: bad resolution string");
  const height = parseInt(resMatch[1], 10);
  const width = parseInt(resMatch[2], 10);
  if (!(width > 0 && height > 0)) throw new Error("HDR: bad resolution string");
  if (offset > bytes.length) throw truncated();

  const pixels = new Float32Array(width * height * 4);
  const scanline = new Uint8Array(width * 4);

  for (let y = 0; y < height; y++) {
    offset = decodeScanline(bytes, offset, width, scanline);
    for (let x = 0; x < width; x++) {
      const r = scanline[x * 4];
      const g = scanline[x * 4 + 1];
      const b = scanline[x * 4 + 2];
      const e = scanline[x * 4 + 3];
      const [fr, fg, fb] = rgbeToFloat(r, g, b, e);
      const pi = (y * width + x) * 4;
      pixels[pi] = fr;
      pixels[pi + 1] = fg;
      pixels[pi + 2] = fb;
      pixels[pi + 3] = 1.0;
    }
  }

  return { pixels, width, height };
}

// ─── Encode ───────────────────────────────────────────────────────────────────

/** Largest value RGBE can hold (mantissa 255, exponent byte 255). */
const RGBE_MAX = 255 * Math.pow(2, 255 - 128 - 8);

/** RGBE can't represent negative values: negatives and NaN become 0, +∞
 *  becomes the largest representable value. */
function rgbeChannel(v: number): number {
  return v > 0 ? Math.min(v, RGBE_MAX) : 0;
}

function floatToRgbe(
  r: number,
  g: number,
  b: number,
): [number, number, number, number] {
  r = rgbeChannel(r);
  g = rgbeChannel(g);
  b = rgbeChannel(b);
  const max = Math.max(r, g, b);
  if (max < 1e-32) return [0, 0, 0, 0];
  // frexp: max = m · 2^exp with m ∈ [0.5, 1), so max · 2^(8-exp) ∈ [128, 256).
  const exp = Math.floor(Math.log2(max)) + 1;
  if (exp + 128 < 1) return [0, 0, 0, 0];
  const scale = Math.pow(2, 8 - exp);
  return [
    Math.min(255, Math.round(r * scale)),
    Math.min(255, Math.round(g * scale)),
    Math.min(255, Math.round(b * scale)),
    Math.min(255, exp + 128),
  ];
}

function encodeRleScanline(channel: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < channel.length) {
    // Find run
    let runLen = 1;
    while (
      runLen < 127 &&
      i + runLen < channel.length &&
      channel[i + runLen] === channel[i]
    )
      runLen++;
    if (runLen > 2) {
      out.push(runLen + 128, channel[i]);
      i += runLen;
    } else {
      // Find non-run
      let nonRunLen = 1;
      while (nonRunLen < 128 && i + nonRunLen < channel.length) {
        let nextRun = 1;
        while (
          nextRun < 3 &&
          i + nonRunLen + nextRun < channel.length &&
          channel[i + nonRunLen + nextRun - 1] === channel[i + nonRunLen]
        )
          nextRun++;
        if (nextRun >= 3) break;
        nonRunLen++;
      }
      out.push(nonRunLen);
      for (let j = 0; j < nonRunLen; j++) out.push(channel[i + j]);
      i += nonRunLen;
    }
  }
  return new Uint8Array(out);
}

export function encodeRgbe(
  pixels: Float32Array,
  width: number,
  height: number,
): Uint8Array {
  const headerStr = `${HDR_HEADER}-Y ${height} +X ${width}\n`;
  const header = new TextEncoder().encode(headerStr);

  const parts: Uint8Array[] = [header];

  // Run-length encoding is only defined for widths 8..0x7fff; other widths
  // are written as flat RGBE scanlines (which is how readers decode them).
  const useRle = rleWidth(width);

  for (let y = 0; y < height; y++) {
    if (!useRle) {
      const flat = new Uint8Array(width * 4);
      for (let x = 0; x < width; x++) {
        const pi = (y * width + x) * 4;
        flat.set(floatToRgbe(pixels[pi], pixels[pi + 1], pixels[pi + 2]), x * 4);
      }
      parts.push(flat);
      continue;
    }

    // Scanline header: [2, 2, widthHigh, widthLow]
    const scanHeader = new Uint8Array([
      2,
      2,
      (width >> 8) & 0xff,
      width & 0xff,
    ]);
    parts.push(scanHeader);

    const channels = [
      new Uint8Array(width),
      new Uint8Array(width),
      new Uint8Array(width),
      new Uint8Array(width),
    ];

    for (let x = 0; x < width; x++) {
      const pi = (y * width + x) * 4;
      const [r, g, b, e] = floatToRgbe(
        pixels[pi],
        pixels[pi + 1],
        pixels[pi + 2],
      );
      channels[0][x] = r;
      channels[1][x] = g;
      channels[2][x] = b;
      channels[3][x] = e;
    }

    for (let ch = 0; ch < 4; ch++) {
      parts.push(encodeRleScanline(channels[ch]));
    }
  }

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
