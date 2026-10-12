import { describe, expect, it } from "vitest";
import { unpackF32Rows, unpackRows } from "@/graphics/webgpu/rendering/readbackUnpack";

describe("readback row unpacking", () => {
  it("strips 256-byte row padding from rgba8 readbacks", () => {
    const w = 3;
    const h = 2;
    const aligned = 256;
    const src = new Uint8Array(aligned * h).fill(0xee);
    for (let y = 0; y < h; y++) for (let i = 0; i < w * 4; i++) src[y * aligned + i] = y * 100 + i;
    const out = unpackRows(src, w, h, aligned);
    expect(out.length).toBe(w * h * 4);
    expect(Array.from(out.subarray(0, 12))).toEqual([...Array(12).keys()]);
    expect(Array.from(out.subarray(12))).toEqual([...Array(12).keys()].map((i) => 100 + i));
    expect(out.includes(0xee)).toBe(false);
  });

  it("returns a copy, not the source, when rows are already tight", () => {
    const src = new Uint8Array(64 * 4 * 2).map((_, i) => i & 0xff);
    const out = unpackRows(src, 64, 2, 256);
    expect(out).toEqual(src);
    expect(out).not.toBe(src);
    out[0] = 99;
    expect(src[0]).toBe(0);
  });

  it("strips float row padding (stride in floats)", () => {
    const w = 2;
    const h = 3;
    const stride = 64; // 256 bytes / 4
    const src = new Float32Array(stride * h).fill(-1);
    for (let y = 0; y < h; y++) for (let i = 0; i < w * 4; i++) src[y * stride + i] = y + i / 10;
    const out = unpackF32Rows(src, w, h, stride);
    expect(out.length).toBe(w * h * 4);
    expect(out.includes(-1)).toBe(false);
    expect(out[8]).toBeCloseTo(1);
    const tight = new Float32Array(w * 4 * h);
    expect(unpackF32Rows(tight, w, h, w * 4)).not.toBe(tight);
  });
});
