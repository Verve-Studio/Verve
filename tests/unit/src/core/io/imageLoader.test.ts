// imageLoader: the pure-TS / WASM decode paths (TGA, PCX, DDS, EXR, PNG) and
// the TGA exporter round trip. JPEG/WebP decode through the browser's <img>
// and aren't covered here.
import { describe, expect, it } from "vitest";
import { DdsFormat, encodeDds, encodeDdsF32, encodeExr } from "@/wasm";
import { deflate } from "@/utils/zlib";
import { srgbToLinearChannel } from "@/utils/pixelFormatConvert";
import { exportTga } from "@/core/io/exportTga";
import { encodePng } from "@/core/io/pngCodec";
import { EXT_TO_MIME, IMAGE_EXTENSIONS, loadImageBytes, loadImagePixels } from "@/core/io/imageLoader";

function rgba8(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < out.length; i++) out[i] = (i * 29 + 3) & 0xff;
  return out;
}

const bytesOf = (d: Uint8Array | Float32Array): Uint8Array =>
  new Uint8Array(d.buffer, d.byteOffset, d.byteLength);

/** 18-byte TGA header. */
function tgaHeader(type: number, w: number, h: number, depth: number, descriptor: number): number[] {
  return [0, 0, type, 0, 0, 0, 0, 0, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, depth, descriptor];
}

describe("extension tables", () => {
  it("every supported extension has a MIME type", () => {
    for (const ext of IMAGE_EXTENSIONS) expect(EXT_TO_MIME[ext], ext).toBeTruthy();
    expect(Object.keys(EXT_TO_MIME).sort()).toEqual([...IMAGE_EXTENSIONS].sort());
  });
});

describe("TGA", () => {
  it("exportTga writes an uncompressed 32-bit top-left-origin header", () => {
    const file = exportTga(rgba8(300, 2), 300, 2);
    expect(Array.from(file.subarray(0, 18))).toEqual(tgaHeader(2, 300, 2, 32, 0x28));
    expect(file.length).toBe(18 + 300 * 2 * 4);
    // BGRA order on disk.
    expect(Array.from(file.subarray(18, 22))).toEqual([3 + 58, 3 + 29, 3, 3 + 87].map((v) => v & 255));
  });

  for (const [w, h] of [
    [1, 1],
    [7, 3],
    [33, 65],
  ] as const) {
    it(`exportTga → loadImageBytes round-trips ${w}×${h} bit-exactly`, async () => {
      const src = rgba8(w, h);
      const out = await loadImageBytes(exportTga(src, w, h), "image/tga");
      expect([out.width, out.height]).toEqual([w, h]);
      expect(bytesOf(out.data)).toEqual(src);
    });
  }

  it("round-trips a fully transparent image (colour under alpha 0 preserved)", async () => {
    const src = new Uint8Array([10, 20, 30, 0, 0, 0, 0, 0]);
    const out = await loadImageBytes(exportTga(src, 2, 1), "image/tga");
    expect(Array.from(bytesOf(out.data))).toEqual([10, 20, 30, 0, 0, 0, 0, 0]);
  });

  it("decodes bottom-up 24-bit files (flipped, opaque)", async () => {
    // 1×2, bottom row first: bottom = blue, top = red (BGR on disk).
    const file = new Uint8Array([...tgaHeader(2, 1, 2, 24, 0), 255, 0, 0, 0, 0, 255]);
    const out = await loadImageBytes(file, "image/tga");
    expect(Array.from(bytesOf(out.data))).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });

  it("decodes RLE (type 10) run and raw packets", async () => {
    // 4×1 top-down 32-bit: run of 3 × (1,2,3,4 RGBA) then a raw pixel.
    const file = new Uint8Array([
      ...tgaHeader(10, 4, 1, 32, 0x28),
      0x82, 3, 2, 1, 4, // run, count 3, BGRA
      0x00, 30, 20, 10, 40, // raw, count 1
    ]);
    const out = await loadImageBytes(file, "image/tga");
    expect(Array.from(bytesOf(out.data))).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 10, 20, 30, 40]);
  });

  it("decodes grayscale (type 3) and skips the image ID field", async () => {
    const hdr = tgaHeader(3, 2, 1, 8, 0x20);
    hdr[0] = 3; // 3-byte image ID
    const file = new Uint8Array([...hdr, 9, 9, 9, 50, 200]);
    const out = await loadImageBytes(file, "image/tga");
    expect(Array.from(bytesOf(out.data))).toEqual([50, 50, 50, 255, 200, 200, 200, 255]);
  });

  it("rejects colour-mapped TGA types", async () => {
    await expect(loadImageBytes(new Uint8Array(tgaHeader(1, 1, 1, 8, 0)), "image/tga")).rejects.toThrow(
      /Unsupported TGA image type: 1/,
    );
  });
});

describe("PCX", () => {
  function pcxHeader(bpp: number, planes: number, w: number, h: number, bytesPerLine: number, encoding = 1): Uint8Array {
    const hdr = new Uint8Array(128);
    const dv = new DataView(hdr.buffer);
    hdr[0] = 0x0a;
    hdr[1] = 5;
    hdr[2] = encoding;
    hdr[3] = bpp;
    dv.setUint16(8, w - 1, true);
    dv.setUint16(10, h - 1, true);
    hdr[65] = planes;
    dv.setUint16(66, bytesPerLine, true);
    return hdr;
  }

  it("decodes 8-bit RLE with a trailing VGA palette", async () => {
    const pal = new Uint8Array(769);
    pal[0] = 0x0c;
    pal.set([10, 20, 30], 1 + 3 * 1); // index 1
    pal.set([200, 100, 50], 1 + 3 * 7); // index 7
    // 3×2: row 0 = 1,1,1 (run of 3); row 1 = 7, 1, 7. bytesPerLine 4 (padded)
    const data = [0xc3, 1, 0, 7, 1, 7, 0];
    const file = new Uint8Array([...pcxHeader(8, 1, 3, 2, 4), ...data, ...pal]);
    const out = await loadImageBytes(file, "image/x-pcx");
    expect([out.width, out.height]).toEqual([3, 2]);
    expect(Array.from(bytesOf(out.data))).toEqual([
      10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255,
      200, 100, 50, 255, 10, 20, 30, 255, 200, 100, 50, 255,
    ]);
  });

  it("decodes 24-bit (3 planes × 8 bpp) uncompressed scanlines", async () => {
    // 2×1: planes R, G, B per scanline.
    const file = new Uint8Array([...pcxHeader(8, 3, 2, 1, 2, 0), 1, 2, 3, 4, 5, 6]);
    const out = await loadImageBytes(file, "image/x-pcx");
    expect(Array.from(bytesOf(out.data))).toEqual([1, 3, 5, 255, 2, 4, 6, 255]);
  });

  it("decodes 1-bit monochrome via the header palette", async () => {
    const hdr = pcxHeader(1, 1, 8, 1, 1, 0);
    hdr.set([0, 0, 0, 255, 255, 255], 16);
    const file = new Uint8Array([...hdr, 0b10100000]);
    const out = await loadImageBytes(file, "image/x-pcx");
    const r = Array.from(bytesOf(out.data)).filter((_, i) => i % 4 === 0);
    expect(r).toEqual([255, 0, 255, 0, 0, 0, 0, 0]);
  });

  it("rejects non-PCX data and unsupported encodings", async () => {
    await expect(loadImageBytes(new Uint8Array(10), "image/x-pcx")).rejects.toThrow(/Failed to decode PCX: Not a PCX file/);
    await expect(loadImageBytes(pcxHeader(8, 1, 1, 1, 1, 2), "image/x-pcx")).rejects.toThrow(/Unsupported PCX encoding/);
  });
});

describe("WASM-backed formats through loadImageBytes", () => {
  it("EXR loads as an HDR float image with exact values", async () => {
    const src = new Float32Array([0.5, 2, 30, 1, 0, 0, 0, 0]);
    const out = await loadImageBytes(await encodeExr(src, 2, 1), "image/x-exr");
    expect(out.isHdr).toBe(true);
    expect(Array.from(out.data)).toEqual(Array.from(src));
  });

  it("DDS RGBA32F / BC6H load as float, BC formats as 8-bit", async () => {
    const f = new Float32Array(4 * 4 * 4).fill(1.5);
    const fl = await loadImageBytes(await encodeDdsF32(f, 4, 4, DdsFormat.RGBA32F), "image/vnd.ms-dds");
    expect(fl.isHdr).toBe(true);
    expect(Array.from(fl.data)).toEqual(Array.from(f));

    const bc6 = await loadImageBytes(await encodeDdsF32(f, 4, 4, DdsFormat.BC6H), "image/vnd.ms-dds");
    expect(bc6.isHdr).toBe(true);
    expect(bc6.data).toBeInstanceOf(Float32Array);

    const px = new Uint8Array(4 * 4 * 4).fill(200);
    const bc7 = await loadImageBytes(await encodeDds(px, 4, 4, DdsFormat.BC7), "image/vnd.ms-dds");
    expect(bc7.isHdr).toBeFalsy();
    expect(bc7.data).toBeInstanceOf(Uint8Array);
    expect([bc7.width, bc7.height]).toEqual([4, 4]);
  });

  it("wraps decode errors with the format name", async () => {
    await expect(loadImageBytes(new Uint8Array(4), "image/vnd.ms-dds")).rejects.toThrow(/Failed to decode DDS/);
    await expect(loadImageBytes(new Uint8Array(4), "image/x-exr")).rejects.toThrow(/Failed to decode EXR/);
  });
});

describe("loadImagePixels", () => {
  it("rejects non-base64 / malformed data URLs", async () => {
    await expect(loadImagePixels("data:image/png,abc")).rejects.toThrow(/Unsupported image data URL/);
    await expect(loadImagePixels("not a url")).rejects.toThrow(/Unsupported image data URL/);
  });

  it("decodes a base64 data URL through the matching decoder", async () => {
    const tga = exportTga(new Uint8Array([1, 2, 3, 4]), 1, 1);
    const url = `data:image/tga;base64,${Buffer.from(tga).toString("base64")}`;
    const out = await loadImagePixels(url);
    expect(Array.from(bytesOf(out.data))).toEqual([1, 2, 3, 4]);
  });
});

describe("PNG", () => {
  /** A 16-bit RGBA PNG (filter 0), optionally with an iCCP chunk. */
  async function png16(px: number[], w: number, h: number, icc?: Uint8Array): Promise<Uint8Array> {
    const crc = (b: Uint8Array): number => {
      let c = ~0;
      for (const v of b) {
        c ^= v;
        for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      }
      return ~c >>> 0;
    };
    const chunk = (type: string, body: Uint8Array): number[] => {
      const t = [...new TextEncoder().encode(type), ...body];
      const c = crc(new Uint8Array(t));
      const len = body.length;
      return [len >>> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255, ...t, c >>> 24, (c >> 16) & 255, (c >> 8) & 255, c & 255];
    };
    const raw: number[] = [];
    for (let y = 0; y < h; y++) {
      raw.push(0);
      for (let i = 0; i < w * 4; i++) {
        const v = px[y * w * 4 + i];
        raw.push(v >> 8, v & 255);
      }
    }
    const ihdr = [0, 0, 0, w, 0, 0, 0, h, 16, 6, 0, 0, 0];
    const iccp = icc ? chunk("iCCP", new Uint8Array([...new TextEncoder().encode("p"), 0, 0, ...(await deflate(icc))])) : [];
    return new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...chunk("IHDR", new Uint8Array(ihdr)),
      ...iccp,
      ...chunk("IDAT", await deflate(new Uint8Array(raw))),
      ...chunk("IEND", new Uint8Array(0)),
    ]);
  }

  it("decodes 8-bit PNGs exactly, including semi-transparent pixels", async () => {
    const src = rgba8(5, 3);
    const out = await loadImageBytes(await encodePng(src, 5, 3), "image/png");
    expect(out.isHdr).toBeFalsy();
    expect(out.data).toEqual(src);
  });

  it("opens an untagged 16-bit PNG as scene-linear float, keeping precision", async () => {
    const px = [0, 32768, 65535, 65535, 1000, 2000, 3000, 32768];
    const out = await loadImageBytes(await png16(px, 2, 1), "image/png");
    expect(out.isHdr).toBe(true);
    expect(out.data).toBeInstanceOf(Float32Array);
    const want = px.map((v, i) => (i % 4 === 3 ? v / 65535 : srgbToLinearChannel(v / 65535)));
    Array.from(out.data).forEach((v, i) => expect(v).toBeCloseTo(want[i], 6));
  });

  it("rounds a 16-bit PNG with an ICC profile to 8 bits (the profile describes encoded samples)", async () => {
    const icc = new Uint8Array(64).map((_, i) => i);
    const out = await loadImageBytes(await png16([0, 32768, 65535, 257 * 9 + 100, 65535, 0, 128, 65535], 2, 1, icc), "image/png");
    expect(out.isHdr).toBeFalsy();
    expect(Array.from(out.data)).toEqual([0, 128, 255, 9, 255, 0, 0, 255]);
    expect(out.iccProfile).toEqual(icc);
  });

  it("reports a decode failure for garbage", async () => {
    await expect(loadImageBytes(new Uint8Array([1, 2, 3, 4]), "image/png")).rejects.toThrow(/Failed to decode PNG/);
  });
});
