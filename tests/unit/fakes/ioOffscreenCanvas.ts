// A tiny software stand-in for OffscreenCanvas + ImageData, enough for the
// browser-encoder path in src/core/io/canvasEncode.ts: putImageData, a solid
// fillRect, drawImage(canvas, 0, 0) with straight-alpha source-over, and
// convertToBlob. PNG output is a real (stored-filter, zlib) PNG; other types
// return a small tagged container — "FAKE" | type | quality | raw RGBA — so
// tests can check what the exporter asked the encoder for. JPEG output is
// framed as SOI, APP0, SOS … EOI so marker-walking post-processors work.
import { deflate } from "@/utils/zlib";

export class FakeImageData {
  readonly data: Uint8ClampedArray;
  constructor(
    data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {
    this.data = data;
  }
}

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

export async function encodeTestPng(rgba: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await deflate(raw, "deflate")),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Decode a PNG written by encodeTestPng (8-bit RGBA, filter 0, no
 *  interlace) — or any such PNG with extra ancillary chunks. */
export async function decodeTestPng(png: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8Array; chunks: string[] }> {
  const { inflate } = await import("@/utils/zlib");
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8;
  let w = 0;
  let h = 0;
  const idat: Uint8Array[] = [];
  const chunks: string[] = [];
  while (p < png.length) {
    const len = dv.getUint32(p);
    const type = new TextDecoder().decode(png.subarray(p + 4, p + 8));
    chunks.push(type);
    const body = png.subarray(p + 8, p + 8 + len);
    if (crc32(png.subarray(p + 4, p + 8 + len)) !== dv.getUint32(p + 8 + len)) throw new Error(`bad CRC in ${type}`);
    if (type === "IHDR") {
      w = new DataView(body.buffer, body.byteOffset).getUint32(0);
      h = new DataView(body.buffer, body.byteOffset).getUint32(4);
    }
    if (type === "IDAT") idat.push(body);
    p += 12 + len;
  }
  const z = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of idat) {
    z.set(c, at);
    at += c.length;
  }
  const raw = await inflate(z, "deflate");
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    if (raw[y * (w * 4 + 1)] !== 0) throw new Error("only filter 0 supported");
    rgba.set(raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1)), y * w * 4);
  }
  return { width: w, height: h, rgba, chunks };
}

/** Parse the tagged container convertToBlob returns for non-PNG types
 *  (it may be preceded by markers a post-processor inserted). */
export function decodeFakeEncoded(bytes: Uint8Array): { type: string; quality: number | undefined; rgba: Uint8Array } {
  const tag = new TextEncoder().encode("FAKE|");
  let start = -1;
  for (let i = 0; i + tag.length <= bytes.length && start < 0; i++) {
    if (tag.every((b, k) => bytes[i + k] === b)) start = i;
  }
  if (start < 0) throw new Error("not a fake-encoded image");
  const fields: string[] = [];
  let p = start + tag.length;
  for (let f = 0; f < 2; f++) {
    const end = bytes.indexOf(0x7c, p); // "|"
    fields.push(new TextDecoder().decode(bytes.subarray(p, end)));
    p = end + 1;
  }
  return {
    type: fields[0],
    quality: fields[1] === "" ? undefined : Number(fields[1]),
    rgba: bytes.slice(p, bytes.length - 2), // strip the trailing EOI
  };
}

export class FakeOffscreenCanvas {
  readonly pixels: Uint8ClampedArray;
  readonly log: string[] = [];
  private fill: [number, number, number] = [0, 0, 0];
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Uint8ClampedArray(width * height * 4);
  }

  getContext(kind: string) {
    if (kind !== "2d") return null;
    const self = this;
    return {
      set fillStyle(v: string) {
        const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
        if (!m) throw new Error(`fake canvas: unsupported fillStyle ${v}`);
        self.fill = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
        self.log.push(`fillStyle ${v}`);
      },
      putImageData(img: FakeImageData, x: number, y: number) {
        if (x !== 0 || y !== 0 || img.width !== self.width) throw new Error("fake canvas: unsupported putImageData");
        self.pixels.set(img.data.subarray(0, self.pixels.length));
        self.log.push("putImageData");
      },
      fillRect(x: number, y: number, w: number, h: number) {
        if (x !== 0 || y !== 0 || w !== self.width || h !== self.height) throw new Error("fake canvas: partial fillRect");
        for (let i = 0; i < self.pixels.length; i += 4) self.pixels.set([...self.fill, 255], i);
        self.log.push("fillRect");
      },
      drawImage(src: FakeOffscreenCanvas, x: number, y: number) {
        if (x !== 0 || y !== 0) throw new Error("fake canvas: offset drawImage");
        const d = self.pixels;
        const s = src.pixels;
        for (let i = 0; i < d.length; i += 4) {
          const sa = s[i + 3] / 255;
          const da = d[i + 3] / 255;
          const oa = sa + da * (1 - sa);
          for (let c = 0; c < 3; c++) {
            d[i + c] = oa === 0 ? 0 : Math.round((s[i + c] * sa + d[i + c] * da * (1 - sa)) / oa);
          }
          d[i + 3] = Math.round(oa * 255);
        }
        self.log.push("drawImage");
      },
    };
  }

  async convertToBlob(opts: { type?: string; quality?: number } = {}): Promise<Blob> {
    const type = opts.type ?? "image/png";
    const rgba = new Uint8Array(this.pixels.buffer.slice(0));
    if (type === "image/png") {
      return new Blob([(await encodeTestPng(rgba, this.width, this.height)) as BlobPart], { type });
    }
    const head = new TextEncoder().encode(`FAKE|${type}|${opts.quality ?? ""}|`);
    // JPEG: SOI, empty APP0, empty SOS header, then the "scan data".
    const prefix = type === "image/jpeg" ? [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xda, 0x00, 0x02] : [];
    const out = new Uint8Array(prefix.length + head.length + rgba.length + 2);
    out.set(prefix, 0);
    out.set(head, prefix.length);
    out.set(rgba, prefix.length + head.length);
    out.set([0xff, 0xd9], out.length - 2);
    return new Blob([out as BlobPart], { type });
  }
}
