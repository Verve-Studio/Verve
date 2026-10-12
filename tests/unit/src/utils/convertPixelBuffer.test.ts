import { beforeAll, describe, expect, it } from "vitest";
import { getPixelOps } from "@/wasm";
import type { PixelFormat } from "@/types";
import { convertPixelBuffer } from "@/utils/convertPixelBuffer";
import { convertRgba8ToF32, srgbToLinearChannel } from "@/utils/pixelFormatConvert";

const PALETTE = [
  { r: 0, g: 0, b: 0, a: 255 },
  { r: 255, g: 255, b: 255, a: 255 },
  { r: 255, g: 0, b: 0, a: 255 },
];

beforeAll(async () => {
  await getPixelOps();
});

describe("convertPixelBuffer", () => {
  it("returns the same buffer when formats match", async () => {
    for (const f of ["rgba8", "rgba32f", "indexed8"] as PixelFormat[]) {
      const data = f === "rgba32f" ? new Float32Array(4) : new Uint8Array(4);
      expect(await convertPixelBuffer(data, f, f, PALETTE)).toBe(data);
    }
  });

  it("rgba8 -> rgba32f is scene-linear for sRGB / auto / untagged sources", async () => {
    const src = new Uint8Array([128, 64, 255, 128]);
    for (const cs of [undefined, "auto", "srgb"] as const) {
      const out = (await convertPixelBuffer(src, "rgba8", "rgba32f", PALETTE, cs)) as Float32Array;
      expect(out).toBeInstanceOf(Float32Array);
      expect(Array.from(out)).toEqual(Array.from(convertRgba8ToF32(src)));
    }
  });

  it("rgba8 -> rgba32f keeps a raw /255 promotion for non-sRGB sources", async () => {
    const src = new Uint8Array([128, 64, 255, 128]);
    for (const cs of ["linear-srgb", "slog3", "aces-cg"] as const) {
      const out = (await convertPixelBuffer(src, "rgba8", "rgba32f", PALETTE, cs)) as Float32Array;
      expect(out[0]).toBeCloseTo(128 / 255, 6);
      expect(out[1]).toBeCloseTo(64 / 255, 6);
    }
  });

  it("rgba32f -> rgba8 gamma-encodes and clamps HDR", async () => {
    const out = await convertPixelBuffer(new Float32Array([5, srgbToLinearChannel(128 / 255), 0, 1]), "rgba32f", "rgba8", PALETTE);
    expect(Array.from(out)).toEqual([255, 128, 0, 255]);
  });

  it("rgba8 -> indexed8 maps to nearest palette entries and alpha 0 to the 255 sentinel", async () => {
    const src = new Uint8Array([
      250, 10, 5, 255, // ~red
      3, 3, 3, 255, // ~black
      240, 240, 240, 255, // ~white
      255, 0, 0, 0, // transparent
    ]);
    const out = await convertPixelBuffer(src, "rgba8", "indexed8", PALETTE);
    expect(Array.from(out)).toEqual([2, 0, 1, 255]);
  });

  it("indexed8 -> rgba8 -> indexed8 round-trips (incl. sentinel)", async () => {
    const idx = new Uint8Array([0, 1, 2, 255, 2, 1]);
    const rgba = await convertPixelBuffer(idx, "indexed8", "rgba8", PALETTE);
    expect(Array.from(rgba.subarray(12, 16))).toEqual([0, 0, 0, 0]);
    const back = await convertPixelBuffer(rgba, "rgba8", "indexed8", PALETTE);
    expect(Array.from(back)).toEqual(Array.from(idx));
  });

  it("indexed8 -> rgba32f -> indexed8 round-trips through linear light", async () => {
    const idx = new Uint8Array([2, 0, 255, 1]);
    const f = (await convertPixelBuffer(idx, "indexed8", "rgba32f", PALETTE)) as Float32Array;
    expect(f).toBeInstanceOf(Float32Array);
    expect(f[0]).toBeCloseTo(1, 6);
    expect(f[12]).toBeCloseTo(srgbToLinearChannel(1), 6);
    expect(f[11]).toBe(0);
    const back = await convertPixelBuffer(f, "rgba32f", "indexed8", PALETTE);
    expect(Array.from(back)).toEqual(Array.from(idx));
  });
});
