// Premultiplied BGRA (Electron nativeImage) ↔ straight RGBA.
import { describe, expect, it } from "vitest";
import { bgraPremulToRgba, rgbaToBgraPremul } from "@/core/io/clipboardBitmap";

describe("clipboard bitmap swizzle", () => {
  it("swaps R/B and premultiplies", () => {
    const rgba = new Uint8Array([200, 100, 50, 255, 200, 100, 50, 128, 200, 100, 50, 0]);
    expect(Array.from(rgbaToBgraPremul(rgba))).toEqual([
      50, 100, 200, 255,
      Math.round((50 * 128) / 255), Math.round((100 * 128) / 255), Math.round((200 * 128) / 255), 128,
      0, 0, 0, 0,
    ]);
  });

  it("opaque pixels round-trip bit-exactly", () => {
    const rgba = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) rgba.set([i, 255 - i, (i * 7) & 255, 255], i * 4);
    expect(bgraPremulToRgba(rgbaToBgraPremul(rgba))).toEqual(rgba);
  });

  it("fully transparent pixels become (0,0,0,0) both ways", () => {
    const rgba = new Uint8Array([9, 8, 7, 0]);
    expect(Array.from(rgbaToBgraPremul(rgba))).toEqual([0, 0, 0, 0]);
    expect(Array.from(bgraPremulToRgba(new Uint8Array([9, 8, 7, 0])))).toEqual([0, 0, 0, 0]);
  });

  it("partial alpha round-trips within the premultiplication quantisation error", () => {
    // Exhaustive over alpha, a spread of channel values.
    for (let a = 1; a < 255; a++) {
      const rgba = new Uint8Array(64 * 4);
      for (let i = 0; i < 64; i++) rgba.set([i * 4, 255 - i * 4, i, a], i * 4);
      const back = bgraPremulToRgba(rgbaToBgraPremul(rgba));
      const tol = Math.ceil(255 / (2 * a));
      for (let i = 0; i < rgba.length; i += 4) {
        expect(back[i + 3]).toBe(a);
        for (let c = 0; c < 3; c++) expect(Math.abs(back[i + c] - rgba[i + c])).toBeLessThanOrEqual(tol);
      }
    }
  });

  it("valid premultiplied data survives unpremultiply → premultiply exactly", () => {
    for (let a = 1; a <= 255; a += 3) {
      const bgra = new Uint8Array((a + 1) * 4);
      for (let p = 0; p <= a; p++) bgra.set([p, a - p, p >> 1, a], p * 4);
      expect(rgbaToBgraPremul(bgraPremulToRgba(bgra))).toEqual(bgra);
    }
  });

  it("clamps invalid premultiplied input (colour > alpha) to 255", () => {
    expect(Array.from(bgraPremulToRgba(new Uint8Array([200, 0, 0, 100])))).toEqual([0, 0, 255, 100]);
  });

  it("returns new buffers and leaves the input untouched", () => {
    const src = new Uint8Array([1, 2, 3, 4]);
    const out = rgbaToBgraPremul(src);
    expect(out).not.toBe(src);
    expect(Array.from(src)).toEqual([1, 2, 3, 4]);
    expect(rgbaToBgraPremul(new Uint8Array(0)).length).toBe(0);
  });
});
