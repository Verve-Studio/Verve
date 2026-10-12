import { describe, expect, it } from "vitest";
import {
  clampF32ToUint8,
  convertF32ToRgba8,
  convertIndexedToF32,
  convertIndexedToRgba8,
  convertRgba8ToF32,
  convertRgba8ToF32Raw,
  linearToSrgbChannel,
  srgbToLinearChannel,
} from "@/utils/pixelFormatConvert";

const PALETTE = [
  { r: 255, g: 0, b: 0, a: 255 },
  { r: 0, g: 128, b: 255, a: 128 },
  { r: 10, g: 20, b: 30, a: 0 },
];

describe("sRGB transfer functions", () => {
  it("fixes black and white", () => {
    expect(srgbToLinearChannel(0)).toBe(0);
    expect(srgbToLinearChannel(1)).toBeCloseTo(1, 12);
    expect(linearToSrgbChannel(0)).toBe(0);
    expect(linearToSrgbChannel(1)).toBeCloseTo(1, 12);
  });

  it("matches IEC 61966-2-1 reference points", () => {
    // 50% sRGB grey is ~21.4% linear light; 18% linear grey encodes to ~46.1%.
    expect(srgbToLinearChannel(0.5)).toBeCloseTo(0.214041, 5);
    expect(linearToSrgbChannel(0.18)).toBeCloseTo(0.461356, 5);
    // Linear toe segment.
    expect(srgbToLinearChannel(0.04)).toBeCloseTo(0.04 / 12.92, 12);
    expect(linearToSrgbChannel(0.003)).toBeCloseTo(0.003 * 12.92, 12);
  });

  it("is continuous at the piecewise breakpoints", () => {
    const eps = 1e-9;
    expect(srgbToLinearChannel(0.04045 + eps)).toBeCloseTo(srgbToLinearChannel(0.04045), 6);
    expect(linearToSrgbChannel(0.0031308 + eps)).toBeCloseTo(linearToSrgbChannel(0.0031308), 6);
  });

  it("is strictly monotonic over [0, 1]", () => {
    let prevL = -1;
    let prevS = -1;
    for (let i = 0; i <= 1000; i++) {
      const c = i / 1000;
      const l = srgbToLinearChannel(c);
      const s = linearToSrgbChannel(c);
      expect(l).toBeGreaterThan(prevL);
      expect(s).toBeGreaterThan(prevS);
      prevL = l;
      prevS = s;
    }
  });

  it("round-trips within float precision", () => {
    for (let i = 0; i <= 200; i++) {
      const c = i / 200;
      expect(linearToSrgbChannel(srgbToLinearChannel(c))).toBeCloseTo(c, 10);
      expect(srgbToLinearChannel(linearToSrgbChannel(c))).toBeCloseTo(c, 10);
    }
  });

  it("clamps negative linear input to 0 and lets HDR values exceed 1", () => {
    expect(linearToSrgbChannel(-0.5)).toBe(0);
    expect(linearToSrgbChannel(4)).toBeGreaterThan(1);
  });
});

describe("rgba8 <-> rgba32f buffers", () => {
  it("decodes RGB with the transfer function but alpha linearly", () => {
    const f = convertRgba8ToF32(new Uint8Array([128, 128, 128, 128]));
    expect(f[0]).toBeCloseTo(srgbToLinearChannel(128 / 255), 6);
    expect(f[3]).toBeCloseTo(128 / 255, 6);
    // Not a naive /255.
    expect(Math.abs(f[0] - 128 / 255)).toBeGreaterThan(0.2);
  });

  it("round-trips every byte value exactly", () => {
    const src = new Uint8Array(256 * 4);
    for (let v = 0; v < 256; v++) src.set([v, 255 - v, v, v], v * 4);
    expect(Array.from(convertF32ToRgba8(convertRgba8ToF32(src)))).toEqual(Array.from(src));
  });

  it("raw promotion is a plain /255 on all channels", () => {
    const f = convertRgba8ToF32Raw(new Uint8Array([0, 51, 255, 102]));
    expect(Array.from(f).map((v) => +v.toFixed(6))).toEqual([0, 0.2, 1, 0.4]);
  });

  it("clamps HDR and negative floats when encoding to bytes", () => {
    const out = convertF32ToRgba8(new Float32Array([16, -1, 0.5, 2]));
    expect(out[0]).toBe(255);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(Math.round(linearToSrgbChannel(0.5) * 255));
    expect(out[3]).toBe(255);
  });

  it("clampF32ToUint8 is identical to convertF32ToRgba8", () => {
    const src = new Float32Array([0.1, 0.9, 3, 0.25, 0, 0.0001, 0.5, 1]);
    expect(Array.from(clampF32ToUint8(src))).toEqual(Array.from(convertF32ToRgba8(src)));
  });

  it("handles empty buffers", () => {
    expect(convertRgba8ToF32(new Uint8Array(0)).length).toBe(0);
    expect(convertF32ToRgba8(new Float32Array(0)).length).toBe(0);
  });
});

describe("indexed8 expansion", () => {
  it("looks up palette entries and leaves the 255 sentinel transparent", () => {
    const out = convertIndexedToRgba8(new Uint8Array([0, 1, 255, 2]), PALETTE);
    expect(Array.from(out)).toEqual([255, 0, 0, 255, 0, 128, 255, 128, 0, 0, 0, 0, 10, 20, 30, 0]);
  });

  it("maps out-of-range indices to transparent black", () => {
    expect(Array.from(convertIndexedToRgba8(new Uint8Array([7]), PALETTE))).toEqual([0, 0, 0, 0]);
  });

  it("indexed -> f32 equals indexed -> rgba8 -> f32 (linear light)", () => {
    const idx = new Uint8Array([0, 1, 255]);
    const f = convertIndexedToF32(idx, PALETTE);
    expect(Array.from(f)).toEqual(Array.from(convertRgba8ToF32(convertIndexedToRgba8(idx, PALETTE))));
    expect(f[4 + 1]).toBeCloseTo(srgbToLinearChannel(128 / 255), 6);
    expect(f[8 + 3]).toBe(0);
  });
});
