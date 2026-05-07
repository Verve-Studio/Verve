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

function decodeScanline(
  data: Uint8Array,
  offset: number,
  width: number,
  scanline: Uint8Array,
): number {
  // Check for new RLE (scanline width >= 8 and <= 0x7fff)
  if (
    width < 8 ||
    width > 0x7fff ||
    data[offset] !== 2 ||
    data[offset + 1] !== 2 ||
    (data[offset + 2] & 0x80) !== 0
  ) {
    // Old format: read raw RGBE pixels
    for (let i = 0; i < width * 4; i++) {
      scanline[i] = data[offset++];
    }
    return offset;
  }

  const scanlineWidth = (data[offset + 2] << 8) | data[offset + 3];
  if (scanlineWidth !== width) throw new Error("HDR: bad scanline width");
  offset += 4;

  // New RLE: 4 channels decoded separately
  for (let ch = 0; ch < 4; ch++) {
    let idx = 0;
    while (idx < width) {
      let code = data[offset++];
      if (code > 128) {
        // Run
        const count = code - 128;
        const val = data[offset++];
        for (let i = 0; i < count; i++) scanline[ch + idx++ * 4] = val;
      } else {
        // Non-run
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

function floatToRgbe(
  r: number,
  g: number,
  b: number,
): [number, number, number, number] {
  const max = Math.max(r, g, b);
  if (max < 1e-32) return [0, 0, 0, 0];
  let exp = Math.ceil(Math.log2(max));
  const scale = Math.pow(2, -exp + 8);
  return [
    Math.min(255, Math.round(r * scale)),
    Math.min(255, Math.round(g * scale)),
    Math.min(255, Math.round(b * scale)),
    exp + 128,
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

  for (let y = 0; y < height; y++) {
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
