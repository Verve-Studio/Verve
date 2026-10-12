// PNG codec: exact straight-alpha round trips, decoding of every colour type
// / bit depth (incl. palette + tRNS and Adam7 interlacing, built here by an
// independent test writer), and errors for corrupt or truncated files.
import { describe, expect, it } from "vitest";
import { extractIccFromPng } from "@/core/cms/iccProfile";
import { deflate } from "@/utils/zlib";
import { decodePng, encodePng } from "@/core/io/pngCodec";

// ─── Independent test writer ─────────────────────────────────────────────────

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
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

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

interface TestPng {
  width: number;
  height: number;
  colorType: number;
  depth: number;
  /** samples[y][x * channels + c] in source units. */
  samples: number[][];
  interlace?: boolean;
  plte?: number[];
  trns?: number[];
  /** Row filter for row index i (of each pass). Default: i % 5. */
  filterFor?: (i: number) => number;
}

/** Build the filtered scanlines of one (sub)image. */
function scanlines(t: TestPng, xs: number[], ys: number[], filterFor: (i: number) => number): Uint8Array {
  const ch = CHANNELS[t.colorType];
  const bits = ch * t.depth;
  const rowBytes = Math.ceil((xs.length * bits) / 8);
  const bpp = Math.max(1, bits >> 3);
  const out: number[] = [];
  let prev = new Uint8Array(rowBytes);
  ys.forEach((y, i) => {
    const row = new Uint8Array(rowBytes);
    xs.forEach((x, k) => {
      for (let c = 0; c < ch; c++) {
        const v = t.samples[y][x * ch + c];
        if (t.depth === 16) {
          row[(k * ch + c) * 2] = v >> 8;
          row[(k * ch + c) * 2 + 1] = v & 255;
        } else if (t.depth === 8) {
          row[k * ch + c] = v;
        } else {
          const bit = k * t.depth;
          row[bit >> 3] |= v << (8 - t.depth - (bit & 7));
        }
      }
    });
    const f = filterFor(i);
    out.push(f);
    for (let j = 0; j < rowBytes; j++) {
      const left = j >= bpp ? row[j - bpp] : 0;
      const up = prev[j];
      const ul = j >= bpp ? prev[j - bpp] : 0;
      const pred = f === 0 ? 0 : f === 1 ? left : f === 2 ? up : f === 3 ? (left + up) >> 1 : paeth(left, up, ul);
      out.push((row[j] - pred) & 255);
    }
    prev = row;
  });
  return new Uint8Array(out);
}

async function writeTestPng(t: TestPng): Promise<Uint8Array> {
  const filterFor = t.filterFor ?? ((i: number) => i % 5);
  const range = (n: number, start = 0, step = 1): number[] => {
    const r: number[] = [];
    for (let v = start; v < n; v += step) r.push(v);
    return r;
  };
  const raw = t.interlace
    ? concat(
        ADAM7.map(([x0, y0, dx, dy]) => {
          const xs = range(t.width, x0, dx);
          const ys = range(t.height, y0, dy);
          return xs.length && ys.length ? scanlines(t, xs, ys, filterFor) : new Uint8Array(0);
        }),
      )
    : scanlines(t, range(t.width), range(t.height), filterFor);
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, t.width);
  new DataView(ihdr.buffer).setUint32(4, t.height);
  ihdr.set([t.depth, t.colorType, 0, 0, t.interlace ? 1 : 0], 8);
  const z = await deflate(raw);
  // Split the image data over two IDAT chunks to cover concatenation.
  const half = Math.floor(z.length / 2);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(t.plte ? [chunk("PLTE", new Uint8Array(t.plte))] : []),
    ...(t.trns ? [chunk("tRNS", new Uint8Array(t.trns))] : []),
    chunk("tEXt", new TextEncoder().encode("Comment\0ignored")),
    chunk("IDAT", z.subarray(0, half)),
    chunk("IDAT", z.subarray(half)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Deterministic samples in [0, max]. */
function samples(w: number, h: number, ch: number, max: number, seed = 1): number[][] {
  let s = seed;
  const rows: number[][] = [];
  for (let y = 0; y < h; y++) {
    const row: number[] = [];
    for (let i = 0; i < w * ch; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      row.push((s >>> 8) % (max + 1));
    }
    rows.push(row);
  }
  return rows;
}

function rgba8(w: number, h: number, seed = 3): Uint8Array {
  return new Uint8Array(samples(w, h, 4, 255, seed).flat());
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("encodePng / decodePng", () => {
  it("round-trips straight-alpha RGBA exactly, incl. semi-transparent and fully transparent pixels", async () => {
    for (const [w, h] of [
      [1, 1],
      [7, 3],
      [33, 17],
    ] as const) {
      const src = rgba8(w, h);
      src.set([25, 200, 7, 128], 0); // a value a premultiplied canvas would alter
      src.set([90, 10, 250, 0], 4 * (w * h - 1));
      const png = await encodePng(src, w, h);
      expect(png[25]).toBe(6); // colour type RGBA
      const out = await decodePng(png);
      expect([out.width, out.height, out.bitDepth]).toEqual([w, h, 8]);
      expect(out.data).toEqual(src);
    }
  });

  it("writes RGB for fully opaque images and decodes them with alpha 255", async () => {
    const src = rgba8(9, 4);
    for (let i = 3; i < src.length; i += 4) src[i] = 255;
    const png = await encodePng(src, 9, 4);
    expect(png[25]).toBe(2); // colour type RGB
    expect((await decodePng(png)).data).toEqual(src);
  });

  it("reads only width × height × 4 bytes from a view into a larger buffer", async () => {
    const host = new Uint8Array(4 + 16 + 8).fill(77);
    const view = host.subarray(4, 20);
    view.set(rgba8(2, 2));
    expect((await decodePng(await encodePng(view, 2, 2))).data).toEqual(rgba8(2, 2));
  });

  it("embeds an ICC profile as iCCP before IDAT and decodes it back", async () => {
    const icc = new Uint8Array(500).map((_, i) => (i * 7) & 255);
    const png = await encodePng(rgba8(3, 2), 3, 2, { iccProfile: icc });
    expect(await extractIccFromPng(png)).toEqual(icc);
    const out = await decodePng(png);
    expect(out.iccProfile).toEqual(icc);
    expect(out.data).toEqual(rgba8(3, 2));
    expect((await decodePng(await encodePng(rgba8(3, 2), 3, 2))).iccProfile).toBeUndefined();
  });

  it("rejects invalid sizes and short buffers", async () => {
    await expect(encodePng(new Uint8Array(0), 0, 1)).rejects.toThrow(/^PNG/);
    await expect(encodePng(new Uint8Array(4), 2, 1)).rejects.toThrow(/^PNG/);
  });
});

describe("decodePng colour types and bit depths", () => {
  it("decodes greyscale at 1, 2, 4 and 8 bits (scaled to 8-bit) with every filter", async () => {
    for (const depth of [1, 2, 4, 8]) {
      const max = (1 << depth) - 1;
      const t: TestPng = { width: 13, height: 6, colorType: 0, depth, samples: samples(13, 6, 1, max) };
      const out = await decodePng(await writeTestPng(t));
      expect(out.bitDepth).toBe(8);
      for (let y = 0; y < 6; y++) {
        for (let x = 0; x < 13; x++) {
          const v = Math.round((t.samples[y][x] * 255) / max);
          expect(Array.from(out.data.subarray((y * 13 + x) * 4, (y * 13 + x) * 4 + 4))).toEqual([v, v, v, 255]);
        }
      }
    }
  });

  it("applies a greyscale tRNS key", async () => {
    const t: TestPng = { width: 2, height: 1, colorType: 0, depth: 4, samples: [[3, 9]], trns: [0, 9] };
    expect(Array.from((await decodePng(await writeTestPng(t))).data)).toEqual([51, 51, 51, 255, 153, 153, 153, 0]);
  });

  it("decodes 16-bit greyscale, grey + alpha and RGB(A) at full precision", async () => {
    for (const colorType of [0, 2, 4, 6]) {
      const ch = CHANNELS[colorType];
      const t: TestPng = { width: 5, height: 4, colorType, depth: 16, samples: samples(5, 4, ch, 65535, colorType + 7) };
      const out = await decodePng(await writeTestPng(t));
      expect(out.bitDepth).toBe(16);
      expect(out.data).toBeInstanceOf(Uint16Array);
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 5; x++) {
          const s = t.samples[y].slice(x * ch, x * ch + ch);
          const want =
            colorType === 0 ? [s[0], s[0], s[0], 65535]
            : colorType === 4 ? [s[0], s[0], s[0], s[1]]
            : colorType === 2 ? [...s, 65535]
            : s;
          expect(Array.from(out.data.subarray((y * 5 + x) * 4, (y * 5 + x) * 4 + 4))).toEqual(want);
        }
      }
    }
  });

  it("decodes 8-bit grey + alpha and RGB with a tRNS colour key", async () => {
    const ga: TestPng = { width: 2, height: 1, colorType: 4, depth: 8, samples: [[10, 20, 30, 40]] };
    expect(Array.from((await decodePng(await writeTestPng(ga))).data)).toEqual([10, 10, 10, 20, 30, 30, 30, 40]);
    const rgb: TestPng = { width: 2, height: 1, colorType: 2, depth: 8, samples: [[1, 2, 3, 4, 5, 6]], trns: [0, 4, 0, 5, 0, 6] };
    expect(Array.from((await decodePng(await writeTestPng(rgb))).data)).toEqual([1, 2, 3, 255, 4, 5, 6, 0]);
  });

  it("decodes palette images at 1, 2, 4 and 8 bits with per-entry tRNS alpha", async () => {
    for (const depth of [1, 2, 4, 8]) {
      const entries = Math.min(1 << depth, 20);
      const plte: number[] = [];
      for (let i = 0; i < entries; i++) plte.push(i * 10, 255 - i * 10, (i * 37) & 255);
      const trns = [0, 128]; // only the first two entries carry alpha
      const t: TestPng = { width: 11, height: 3, colorType: 3, depth, samples: samples(11, 3, 1, entries - 1, depth), plte, trns };
      const out = await decodePng(await writeTestPng(t));
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 11; x++) {
          const v = t.samples[y][x];
          const want = [plte[v * 3], plte[v * 3 + 1], plte[v * 3 + 2], v < 2 ? trns[v] : 255];
          expect(Array.from(out.data.subarray((y * 11 + x) * 4, (y * 11 + x) * 4 + 4))).toEqual(want);
        }
      }
    }
  });

  it("rejects palette indices outside the palette", async () => {
    const t: TestPng = { width: 1, height: 1, colorType: 3, depth: 8, samples: [[5]], plte: [1, 2, 3] };
    await expect(decodePng(await writeTestPng(t))).rejects.toThrow(/palette index/);
  });

  it("decodes Adam7-interlaced images (incl. sizes where passes are empty) like their progressive twin", async () => {
    const cases: [number, number, number, number][] = [
      [1, 1, 6, 8],
      [3, 5, 2, 8],
      [9, 10, 6, 16],
      [17, 3, 0, 1],
      [5, 4, 3, 4],
    ];
    for (const [w, h, colorType, depth] of cases) {
      const ch = CHANNELS[colorType];
      const max = colorType === 3 ? 3 : (1 << depth) - 1;
      const base: TestPng = {
        width: w,
        height: h,
        colorType,
        depth,
        samples: samples(w, h, ch, max, w * 31 + h),
        plte: colorType === 3 ? [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255] : undefined,
      };
      const progressive = await decodePng(await writeTestPng(base));
      const interlaced = await decodePng(await writeTestPng({ ...base, interlace: true }));
      expect(interlaced.data).toEqual(progressive.data);
    }
  });
});

describe("decodePng errors", () => {
  it("rejects a bad signature", async () => {
    await expect(decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).rejects.toThrow(/not a PNG/);
  });

  it("rejects a chunk with a bad CRC", async () => {
    const png = await encodePng(rgba8(4, 4), 4, 4);
    const bad = png.slice();
    bad[45] ^= 0xff; // inside the first IDAT payload (chunk starts at 33)
    await expect(decodePng(bad)).rejects.toThrow(/bad CRC in IDAT/);
  });

  it("rejects files truncated inside a chunk", async () => {
    const png = await encodePng(rgba8(8, 8), 8, 8);
    for (const cut of [10, 20, 40, png.length - 13]) {
      await expect(decodePng(png.subarray(0, cut))).rejects.toThrow(/^PNG: truncated/);
    }
  });

  it("rejects image data that inflates to too few scanlines", async () => {
    const t: TestPng = { width: 4, height: 4, colorType: 6, depth: 8, samples: samples(4, 4, 4, 255) };
    const png = await writeTestPng(t);
    // Rebuild with only two scanlines' worth of (valid) compressed data.
    const ihdr = png.subarray(8, 8 + 25);
    const short = await deflate(new Uint8Array(2 * (4 * 4 + 1)));
    const file = concat([png.subarray(0, 8), ihdr, chunk("IDAT", short), chunk("IEND", new Uint8Array(0))]);
    await expect(decodePng(file)).rejects.toThrow(/truncated image data/);
  });

  it("rejects an invalid colour type / bit depth combination and unknown critical chunks", async () => {
    const png = await encodePng(rgba8(2, 2), 2, 2);
    const ihdr = png.slice(8, 33);
    ihdr[8 + 8] = 4; // RGBA at 4 bits: invalid
    const bad = concat([png.subarray(0, 8), chunk("IHDR", ihdr.subarray(8, 21)), png.subarray(33)]);
    await expect(decodePng(bad)).rejects.toThrow(/unsupported colour type/);
    const withCritical = concat([png.subarray(0, 33), chunk("ZZZZ", new Uint8Array(1)), png.subarray(33)]);
    await expect(decodePng(withCritical)).rejects.toThrow(/critical chunk ZZZZ/);
  });
});
