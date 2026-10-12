// ─── PNG codec ────────────────────────────────────────────────────────────────
//
// Encodes and decodes PNG directly instead of going through a 2D canvas. A
// canvas stores premultiplied alpha, so semi-transparent pixels do not
// survive a putImageData → encode or decode → getImageData round trip
// exactly; this codec works on straight (non-premultiplied) RGBA.
//
// Encoder: 8-bit RGB (when every pixel is opaque) or RGBA, adaptive per-row
// filtering, optional iCCP profile. Decoder: every colour type and bit depth
// (1–16), PLTE + tRNS, Adam7 interlacing, CRC checks.

import { inflate } from "@/utils/zlib";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Largest IDAT payload the encoder writes per chunk. */
const IDAT_CHUNK = 1 << 20;

// ─── CRC-32 (ISO 3309, as used by PNG) ───────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// ─── Filters ─────────────────────────────────────────────────────────────────

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reverse `filter` on `row` in place, given the previous unfiltered row
 *  (`prev`, all zero for the first row) and the filter byte distance `bpp`. */
function unfilterRow(filter: number, row: Uint8Array, prev: Uint8Array, bpp: number): void {
  const n = row.length;
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < n; i++) row[i] = (row[i] + row[i - bpp]) & 0xff;
      return;
    case 2:
      for (let i = 0; i < n; i++) row[i] = (row[i] + prev[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        row[i] = (row[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const upLeft = i >= bpp ? prev[i - bpp] : 0;
        row[i] = (row[i] + paeth(left, prev[i], upLeft)) & 0xff;
      }
      return;
    default:
      throw new Error(`PNG: invalid filter type ${filter}`);
  }
}

/** Filter `row` with `filter` into `out` (without the filter byte). */
function filterRow(filter: number, row: Uint8Array, prev: Uint8Array, bpp: number, out: Uint8Array): void {
  const n = row.length;
  for (let i = 0; i < n; i++) {
    const left = i >= bpp ? row[i - bpp] : 0;
    const up = prev[i];
    const upLeft = i >= bpp ? prev[i - bpp] : 0;
    let pred = 0;
    if (filter === 1) pred = left;
    else if (filter === 2) pred = up;
    else if (filter === 3) pred = (left + up) >> 1;
    else if (filter === 4) pred = paeth(left, up, upLeft);
    out[i] = (row[i] - pred) & 0xff;
  }
}

// ─── Encode ──────────────────────────────────────────────────────────────────

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function zlibCompress(write: (emit: (bytes: Uint8Array) => Promise<void>) => Promise<void>): Promise<Uint8Array[]> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  const output = readAll(cs.readable as ReadableStream<Uint8Array>);
  try {
    await write((bytes) => writer.write(bytes as Uint8Array<ArrayBuffer>));
    await writer.close();
  } catch (err) {
    await writer.abort(err).catch(() => {});
    throw err;
  }
  return output;
}

export interface PngEncodeOptions {
  /** Raw ICC profile bytes, embedded as an `iCCP` chunk. */
  iccProfile?: Uint8Array;
}

/**
 * Encode straight-alpha RGBA8 pixels (top row first) as a PNG. Writes RGB
 * when every pixel is opaque, RGBA otherwise; pixel values are stored
 * exactly. Rows are filtered adaptively and streamed into the compressor,
 * so no second full-size buffer is allocated.
 */
export async function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: PngEncodeOptions = {},
): Promise<Uint8Array> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`PNG: invalid image size ${width}×${height}`);
  }
  const pixelCount = width * height;
  if (rgba.length < pixelCount * 4) throw new Error("PNG: pixel buffer is smaller than the image");

  let opaque = true;
  for (let i = 3; i < pixelCount * 4; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const channels = opaque ? 3 : 4;
  const rowBytes = width * channels;

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6; // colour type: RGB / RGBA
  // compression 0, filter method 0, no interlace

  const compressed = await zlibCompress(async (emit) => {
    let prev = new Uint8Array(rowBytes);
    let cur = new Uint8Array(rowBytes);
    const candidate = new Uint8Array(rowBytes);
    const batchRows = Math.max(1, Math.floor((1 << 20) / (rowBytes + 1)));
    let batch = new Uint8Array(Math.min(batchRows, height) * (rowBytes + 1));
    let inBatch = 0;
    for (let y = 0; y < height; y++) {
      const src = rgba.subarray(y * width * 4, (y + 1) * width * 4);
      if (opaque) {
        for (let x = 0, s = 0, d = 0; x < width; x++, s += 4, d += 3) {
          cur[d] = src[s];
          cur[d + 1] = src[s + 1];
          cur[d + 2] = src[s + 2];
        }
      } else {
        cur.set(src);
      }
      // Pick the filter with the smallest sum of absolute (signed) bytes.
      const dst = batch.subarray(inBatch * (rowBytes + 1), (inBatch + 1) * (rowBytes + 1));
      let best = Infinity;
      for (let f = 0; f < 5; f++) {
        filterRow(f, cur, prev, channels, candidate);
        let sum = 0;
        for (let i = 0; i < rowBytes && sum < best; i++) {
          const v = candidate[i];
          sum += v < 128 ? v : 256 - v;
        }
        if (sum < best) {
          best = sum;
          dst[0] = f;
          dst.set(candidate, 1);
        }
      }
      inBatch++;
      if (inBatch * (rowBytes + 1) === batch.length || y === height - 1) {
        await emit(batch.subarray(0, inBatch * (rowBytes + 1)));
        // The stream may hold on to the written chunk: use a fresh buffer.
        batch = new Uint8Array(batch.length);
        inBatch = 0;
      }
      const t = prev;
      prev = cur;
      cur = t;
    }
  });

  const parts: Uint8Array[] = [new Uint8Array(SIGNATURE), chunk("IHDR", ihdr)];
  if (options.iccProfile && options.iccProfile.length > 0) {
    const name = new TextEncoder().encode("ICC Profile");
    const z = concat(await zlibCompress((emit) => emit(options.iccProfile!)));
    const body = new Uint8Array(name.length + 2 + z.length);
    body.set(name, 0); // then a null terminator and compression method 0
    body.set(z, name.length + 2);
    parts.push(chunk("iCCP", body));
  }
  // Re-slice the compressor's output into IDAT chunks of bounded size.
  const z = concat(compressed);
  for (let at = 0; at < z.length; at += IDAT_CHUNK) {
    parts.push(chunk("IDAT", z.subarray(at, Math.min(z.length, at + IDAT_CHUNK))));
  }
  parts.push(chunk("IEND", new Uint8Array(0)));
  return concat(parts);
}

// ─── Decode ──────────────────────────────────────────────────────────────────

export interface DecodedPng {
  width: number;
  height: number;
  /** Bit depth of `data`: 16 for 16-bit greyscale / RGB(A) files, else 8. */
  bitDepth: 8 | 16;
  /** Straight-alpha RGBA, top row first: `Uint8Array` when `bitDepth` is 8,
   *  `Uint16Array` (0–65535) when it is 16. */
  data: Uint8Array | Uint16Array;
  /** The `iCCP` profile, decompressed, when the file has one. */
  iccProfile?: Uint8Array;
}

const ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const VALID_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export function isPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

/** Decode a PNG file to straight-alpha RGBA. Throws a "PNG: …" error for
 *  malformed, truncated or corrupt files. */
export async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  if (!isPngSignature(bytes)) throw new Error("PNG: not a PNG file (bad signature)");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  let iccCompressed: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let sawIhdr = false;
  let sawIend = false;

  let p = 8;
  while (p < bytes.length) {
    if (p + 8 > bytes.length) throw new Error("PNG: truncated file (incomplete chunk header)");
    const len = dv.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    if (len > 0x7fffffff || p + 12 + len > bytes.length) {
      throw new Error(`PNG: truncated file (${type} chunk runs past the end)`);
    }
    const body = bytes.subarray(p + 8, p + 8 + len);
    if (crc32(bytes.subarray(p + 4, p + 8 + len)) !== dv.getUint32(p + 8 + len)) {
      throw new Error(`PNG: bad CRC in ${type} chunk (file is corrupt)`);
    }
    if (!sawIhdr && type !== "IHDR") throw new Error("PNG: missing IHDR chunk");
    switch (type) {
      case "IHDR": {
        if (len !== 13) throw new Error("PNG: bad IHDR chunk");
        const h = new DataView(body.buffer, body.byteOffset, 13);
        width = h.getUint32(0);
        height = h.getUint32(4);
        depth = body[8];
        colorType = body[9];
        interlace = body[12];
        if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
          throw new Error(`PNG: invalid image size ${width}×${height}`);
        }
        if (!(colorType in CHANNELS) || !VALID_DEPTHS[colorType].includes(depth)) {
          throw new Error(`PNG: unsupported colour type ${colorType} at bit depth ${depth}`);
        }
        if (body[10] !== 0 || body[11] !== 0 || interlace > 1) {
          throw new Error("PNG: unsupported compression, filter or interlace method");
        }
        sawIhdr = true;
        break;
      }
      case "PLTE":
        if (len % 3 !== 0 || len === 0 || len > 768) throw new Error("PNG: bad PLTE chunk");
        palette = body;
        break;
      case "tRNS":
        trns = body;
        break;
      case "iCCP":
        iccCompressed = body;
        break;
      case "IDAT":
        idat.push(body);
        break;
      case "IEND":
        sawIend = true;
        break;
      default:
        // Unknown critical chunks (upper-case first letter) can't be skipped.
        if (type.charCodeAt(0) & 0x20) break;
        throw new Error(`PNG: unsupported critical chunk ${type}`);
    }
    p += 12 + len;
    if (sawIend) break;
  }
  if (!sawIhdr) throw new Error("PNG: missing IHDR chunk");
  if (idat.length === 0) throw new Error("PNG: no image data (missing IDAT)");
  if (colorType === 3 && !palette) throw new Error("PNG: palette image without a PLTE chunk");

  let raw: Uint8Array;
  try {
    raw = await inflate(concat(idat));
  } catch (err) {
    throw new Error(`PNG: corrupt or truncated image data (${(err as Error).message})`);
  }

  const channels = CHANNELS[colorType];
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const out16 = depth === 16 && colorType !== 3;
  const out: Uint8Array | Uint16Array = out16
    ? new Uint16Array(width * height * 4)
    : new Uint8Array(width * height * 4);
  const maxOut = out16 ? 65535 : 255;

  // Grey sample scaling for bit depths below 8 (1 → 255, 2 → 85, 4 → 17).
  const greyScale = depth < 8 ? 255 / ((1 << depth) - 1) : 1;
  // Transparency key (grey / RGB) in source sample units.
  let keyGrey = -1;
  let keyR = -1;
  let keyG = -1;
  let keyB = -1;
  if (trns && colorType === 0 && trns.length >= 2) keyGrey = (trns[0] << 8) | trns[1];
  if (trns && colorType === 2 && trns.length >= 6) {
    keyR = (trns[0] << 8) | trns[1];
    keyG = (trns[2] << 8) | trns[3];
    keyB = (trns[4] << 8) | trns[5];
  }
  const paletteCount = palette ? palette.length / 3 : 0;

  const passes = interlace ? ADAM7 : ([[0, 0, 1, 1]] as const);
  let at = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bitsPerPixel) / 8);
    let prev: Uint8Array = new Uint8Array(rowBytes);
    for (let y = 0; y < ph; y++) {
      if (at + 1 + rowBytes > raw.length) throw new Error("PNG: truncated image data");
      const filter = raw[at];
      const row = raw.subarray(at + 1, at + 1 + rowBytes);
      unfilterRow(filter, row, prev, bpp);
      at += 1 + rowBytes;
      prev = row;

      const oy = y0 + y * dy;
      for (let x = 0; x < pw; x++) {
        const o = ((oy * width) + x0 + x * dx) * 4;
        let r: number;
        let g: number;
        let b: number;
        let a = maxOut;
        if (depth < 8) {
          const bit = x * depth;
          const v = (row[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
          if (colorType === 3) {
            if (v >= paletteCount) throw new Error("PNG: palette index out of range");
            r = palette![v * 3];
            g = palette![v * 3 + 1];
            b = palette![v * 3 + 2];
            a = trns && v < trns.length ? trns[v] : 255;
          } else {
            r = g = b = Math.round(v * greyScale);
            if (v === keyGrey) a = 0;
          }
        } else if (colorType === 3) {
          const v = row[x];
          if (v >= paletteCount) throw new Error("PNG: palette index out of range");
          r = palette![v * 3];
          g = palette![v * 3 + 1];
          b = palette![v * 3 + 2];
          a = trns && v < trns.length ? trns[v] : 255;
        } else {
          // Sample c of this pixel, big-endian for 16-bit.
          const s = x * channels;
          const wide = depth === 16;
          const s0 = wide ? (row[s * 2] << 8) | row[s * 2 + 1] : row[s];
          if (colorType === 0 || colorType === 4) {
            r = g = b = s0;
            if (colorType === 4) a = wide ? (row[s * 2 + 2] << 8) | row[s * 2 + 3] : row[s + 1];
            else if (s0 === keyGrey) a = 0;
          } else {
            r = s0;
            g = wide ? (row[s * 2 + 2] << 8) | row[s * 2 + 3] : row[s + 1];
            b = wide ? (row[s * 2 + 4] << 8) | row[s * 2 + 5] : row[s + 2];
            if (colorType === 6) a = wide ? (row[s * 2 + 6] << 8) | row[s * 2 + 7] : row[s + 3];
            else if (r === keyR && g === keyG && b === keyB) a = 0;
          }
        }
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = a;
      }
    }
  }

  let iccProfile: Uint8Array | undefined;
  if (iccCompressed) {
    // name (1–79 bytes) + NUL + compression method 0 + zlib data.
    const nul = iccCompressed.indexOf(0);
    if (nul > 0 && iccCompressed[nul + 1] === 0) {
      try {
        iccProfile = await inflate(iccCompressed.subarray(nul + 2));
      } catch {
        iccProfile = undefined; // a broken profile doesn't stop the image
      }
    }
  }

  return { width, height, bitDepth: out16 ? 16 : 8, data: out, iccProfile };
}
