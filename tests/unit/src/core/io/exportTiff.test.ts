// 8-bit TIFF (UTIF) and 32-bit float TIFF writers, verified by decoding with
// UTIF directly and through the app's loader.
import { describe, expect, it } from "vitest";
import * as UTIF from "utif";
import { exportTiff } from "@/core/io/exportTiff";
import { exportTiff32 } from "@/core/io/exportTiff32";
import { loadImageBytes } from "@/core/io/imageLoader";

function rgba8(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < out.length; i++) out[i] = (i * 53 + 7) & 0xff;
  return out;
}

function f32(w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set([i * 0.5, 100.25, -0, (i % 4) / 4], i * 4);
  return out;
}

const ab = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe("exportTiff (8-bit RGBA)", () => {
  for (const [w, h] of [
    [1, 1],
    [7, 3],
    [64, 33],
  ] as const) {
    it(`round-trips ${w}×${h} RGBA bit-exactly, incl. alpha`, async () => {
      const src = rgba8(w, h);
      const file = exportTiff(src, w, h);
      // Independent decode with UTIF.
      const ifds = UTIF.decode(ab(file));
      expect(ifds).toHaveLength(1);
      UTIF.decodeImage(ab(file), ifds[0]);
      expect([ifds[0].width, ifds[0].height]).toEqual([w, h]);
      expect(new Uint8Array(UTIF.toRGBA8(ifds[0]))).toEqual(src);
      // App loader.
      const out = await loadImageBytes(file, "image/tiff");
      expect([out.width, out.height]).toEqual([w, h]);
      expect(out.isHdr).toBeFalsy();
      expect(new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength)).toEqual(src);
      expect(out.iccProfile).toBeUndefined();
    });
  }

  it("round-trips a fully transparent image", async () => {
    const src = new Uint8Array(3 * 2 * 4);
    const out = await loadImageBytes(exportTiff(src, 3, 2), "image/tiff");
    expect(new Uint8Array(out.data.buffer)).toEqual(src);
  });

  it("embeds an ICC profile that the loader extracts again", async () => {
    const icc = new Uint8Array(200);
    for (let i = 0; i < icc.length; i++) icc[i] = i;
    const src = rgba8(4, 4);
    const file = exportTiff(src, 4, 4, { iccProfile: icc });
    const out = await loadImageBytes(file, "image/tiff");
    expect(out.iccProfile).toEqual(icc);
    expect(new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength)).toEqual(src);
  });

  it("decodes a TIFF that is a view into a larger buffer", async () => {
    const file = exportTiff(rgba8(2, 2), 2, 2);
    const host = new Uint8Array(file.length + 13);
    host.set(file, 5);
    const out = await loadImageBytes(host.subarray(5, 5 + file.length), "image/tiff");
    expect(new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength)).toEqual(rgba8(2, 2));
  });

  it("reports a decode failure for garbage", async () => {
    await expect(loadImageBytes(new Uint8Array([1, 2, 3, 4]), "image/tiff")).rejects.toThrow(/Failed to decode TIFF/);
  });
});

describe("exportTiff32 (IEEE float RGBA)", () => {
  it("writes a little-endian float TIFF with the expected tags", () => {
    const file = exportTiff32(f32(3, 2), 3, 2);
    const ifds = UTIF.decode(ab(file)) as unknown as Array<Record<string, number[]>>;
    const ifd = ifds[0];
    expect(file[0]).toBe(0x49); // "II"
    expect(ifd.t256[0]).toBe(3);
    expect(ifd.t257[0]).toBe(2);
    expect(ifd.t258).toEqual([32, 32, 32, 32]);
    expect(ifd.t339).toEqual([3, 3, 3, 3]);
    expect(ifd.t277[0]).toBe(4);
    expect(ifd.t259[0]).toBe(1);
    expect(ifd.t338[0]).toBe(2); // unassociated alpha
  });

  for (const [w, h] of [
    [1, 1],
    [5, 3],
    [40, 17],
  ] as const) {
    it(`round-trips ${w}×${h} scene-linear floats bit-exactly (HDR > 1, alpha)`, async () => {
      const src = f32(w, h);
      const out = await loadImageBytes(exportTiff32(src, w, h), "image/tiff");
      expect(out.isHdr).toBe(true);
      expect([out.width, out.height]).toEqual([w, h]);
      expect(out.data).toBeInstanceOf(Float32Array);
      expect(Array.from(out.data)).toEqual(Array.from(src));
    });
  }

  it("stores raw floats: no clamping or transfer function", () => {
    const src = new Float32Array([1e30, 0.5, 1e-30, 1]);
    const file = exportTiff32(src, 1, 1);
    const tail = file.slice(file.length - 16);
    expect(Array.from(new Float32Array(tail.buffer))).toEqual(Array.from(src));
  });
});
