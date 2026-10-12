import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RGBAColor } from "@/types";
import { getPixelOps } from "@/wasm";
import { clipboardToFormat } from "@/core/io/clipboardPixels";
import { clipboardStore, type ClipboardData } from "@/core/store/clipboardStore";

// clipboardToFormat matches colours to the palette through the WASM module.
beforeAll(async () => {
  await getPixelOps();
});

afterEach(() => {
  clipboardStore.current = null;
});

const RED: RGBAColor = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: RGBAColor = { r: 0, g: 255, b: 0, a: 255 };
const BLUE: RGBAColor = { r: 0, g: 0, b: 255, a: 255 };
const BLACK: RGBAColor = { r: 0, g: 0, b: 0, a: 255 };
const WHITE: RGBAColor = { r: 255, g: 255, b: 255, a: 255 };

function rgba8Clip(pixels: number[][]): ClipboardData {
  return {
    format: "rgba8",
    data: new Uint8Array(pixels.flat()),
    width: pixels.length,
    height: 1,
    offsetX: 0,
    offsetY: 0,
  };
}

describe("clipboardStore", () => {
  it("holds the last copy in its native format", () => {
    expect(clipboardStore.current).toBeNull();
    const clip: ClipboardData = {
      format: "rgba32f",
      data: new Float32Array([2.5, 0, 0, 1]),
      width: 1,
      height: 1,
      offsetX: 3,
      offsetY: 4,
    };
    clipboardStore.current = clip;
    expect(clipboardStore.current.format).toBe("rgba32f");
    expect(clipboardStore.current.data).toBe(clip.data);
  });
});

describe("clipboardToFormat", () => {
  it("same-format rgba paste is lossless (HDR floats keep values > 1)", async () => {
    const data = new Float32Array([4, 0.5, 0, 0.25]);
    const out = await clipboardToFormat(
      { format: "rgba32f", data, width: 1, height: 1, offsetX: 0, offsetY: 0 },
      "rgba32f",
      [],
    );
    expect([...out]).toEqual([4, 0.5, 0, 0.25]);
  });

  it("rgba8 → rgba32f decodes sRGB to linear light (not ÷255)", async () => {
    const out = (await clipboardToFormat(rgba8Clip([[128, 255, 0, 128]]), "rgba32f", [])) as Float32Array;
    expect(out).toBeInstanceOf(Float32Array);
    expect(out[0]).toBeCloseTo(0.2158, 3); // sRGB 128 → linear ≈ 0.216
    expect(out[1]).toBeCloseTo(1, 5);
    expect(out[2]).toBe(0);
    expect(out[3]).toBeCloseTo(128 / 255, 5); // alpha is linear
  });

  it("rgba32f → rgba8 encodes linear to sRGB bytes", async () => {
    const out = await clipboardToFormat(
      { format: "rgba32f", data: new Float32Array([0.2158, 1, 0, 1]), width: 1, height: 1, offsetX: 0, offsetY: 0 },
      "rgba8",
      [],
    );
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Math.abs(out[0] - 128)).toBeLessThanOrEqual(1);
    expect(out[1]).toBe(255);
    expect(out[3]).toBe(255);
  });

  it("rgba8 → indexed8 maps each colour to the nearest palette entry", async () => {
    const palette = [BLACK, RED, GREEN, BLUE];
    const out = await clipboardToFormat(
      rgba8Clip([
        [250, 10, 5, 255], // ≈ red
        [3, 3, 240, 255], // ≈ blue
        [0, 0, 0, 255], // exact black
      ]),
      "indexed8",
      palette,
    );
    expect(out).toBeInstanceOf(Uint8Array);
    expect([...out]).toEqual([1, 3, 0]);
  });

  it("rgba → indexed8: pixels under half opacity become transparent (255)", async () => {
    const palette = [RED, GREEN];
    const out = await clipboardToFormat(
      rgba8Clip([
        [255, 0, 0, 127],
        [255, 0, 0, 128],
        [0, 255, 0, 0],
      ]),
      "indexed8",
      palette,
    );
    expect([...out]).toEqual([255, 0, 255]);
  });

  it("rgba32f → indexed8 goes through sRGB bytes before matching", async () => {
    const palette = [BLACK, { r: 128, g: 128, b: 128, a: 255 }, WHITE];
    const out = await clipboardToFormat(
      { format: "rgba32f", data: new Float32Array([0.2158, 0.2158, 0.2158, 1]), width: 1, height: 1, offsetX: 0, offsetY: 0 },
      "indexed8",
      palette,
    );
    // Linear 0.216 is sRGB mid-grey; a naive ×255 would land nearer black.
    expect([...out]).toEqual([1]);
  });

  it("indexed8 → indexed8 within the same palette is exact (indices kept)", async () => {
    // Duplicate colours: a nearest-colour search would collapse 2 onto 0.
    const palette = [RED, GREEN, RED, BLUE];
    const out = await clipboardToFormat(
      { format: "indexed8", data: new Uint8Array([0, 1, 2, 3, 255]), palette, width: 5, height: 1, offsetX: 0, offsetY: 0 },
      "indexed8",
      palette,
    );
    expect([...out]).toEqual([0, 1, 2, 3, 255]);
  });

  it("indexed8 → indexed8 across palettes remaps to the nearest colour", async () => {
    const from = [RED, GREEN, BLUE];
    const to = [BLUE, { r: 240, g: 10, b: 10, a: 255 }, GREEN];
    const out = await clipboardToFormat(
      { format: "indexed8", data: new Uint8Array([0, 1, 2, 255]), palette: from, width: 4, height: 1, offsetX: 0, offsetY: 0 },
      "indexed8",
      to,
    );
    expect([...out]).toEqual([1, 2, 0, 255]);
  });

  it("indexed8 → rgba8 uses the clip's own palette, not the target's", async () => {
    const out = await clipboardToFormat(
      { format: "indexed8", data: new Uint8Array([1, 255]), palette: [RED, GREEN], width: 2, height: 1, offsetX: 0, offsetY: 0 },
      "rgba8",
      [BLUE, BLUE],
    );
    expect([...out]).toEqual([0, 255, 0, 255, 0, 0, 0, 0]);
  });

  it("indexed8 → rgba32f yields linear floats from the clip palette", async () => {
    const out = (await clipboardToFormat(
      { format: "indexed8", data: new Uint8Array([0]), palette: [WHITE], width: 1, height: 1, offsetX: 0, offsetY: 0 },
      "rgba32f",
      [],
    )) as Float32Array;
    expect(out).toBeInstanceOf(Float32Array);
    expect([...out].map((v) => Math.round(v * 1e5) / 1e5)).toEqual([1, 1, 1, 1]);
  });
});
