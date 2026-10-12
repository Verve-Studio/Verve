// Format-native clipboard: cropping, 8-bit system-clipboard view and
// conversion into the paste target's format.
import { describe, expect, it } from "vitest";
import type { ClipboardData } from "@/core/store/clipboardStore";
import type { RGBAColor } from "@/types";
import { clipboardToFormat, clipboardToRgba8, cropToClipboard, type ClipboardSource } from "@/core/io/clipboardPixels";

const PALETTE: RGBAColor[] = [
  { r: 0, g: 0, b: 0, a: 255 },
  { r: 255, g: 0, b: 0, a: 255 },
  { r: 0, g: 255, b: 0, a: 255 },
  { r: 255, g: 255, b: 255, a: 255 },
];

/** 4×3 rgba8 layer with one opaque 2×1 strip at layer (1, 1). */
function strip(): ClipboardSource {
  const data = new Uint8Array(4 * 3 * 4);
  data.set([10, 20, 30, 255, 40, 50, 60, 200], (1 * 4 + 1) * 4);
  return { format: "rgba8", data, width: 4, height: 3, offsetX: 0, offsetY: 0 };
}

describe("cropToClipboard", () => {
  it("crops to the bounding box of visible pixels and keeps the canvas offset", () => {
    const clip = cropToClipboard(strip(), null, 4, 3)!;
    expect(clip).toMatchObject({ format: "rgba8", width: 2, height: 1, offsetX: 1, offsetY: 1 });
    expect(Array.from(clip.data)).toEqual([10, 20, 30, 255, 40, 50, 60, 200]);
  });

  it("returns null when nothing is visible or selected", () => {
    const empty: ClipboardSource = { format: "rgba8", data: new Uint8Array(16), width: 2, height: 2, offsetX: 0, offsetY: 0 };
    expect(cropToClipboard(empty, null, 2, 2)).toBeNull();
    expect(cropToClipboard(strip(), new Uint8Array(12), 4, 3)).toBeNull();
  });

  it("clips a layer that hangs off the canvas", () => {
    // 3×1 opaque layer at canvas (-1, 0) on a 2×1 canvas: only layer x 1..2 remain.
    const src: ClipboardSource = {
      format: "rgba8",
      data: new Uint8Array([1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255]),
      width: 3,
      height: 1,
      offsetX: -1,
      offsetY: 0,
    };
    const clip = cropToClipboard(src, null, 2, 1)!;
    expect(clip).toMatchObject({ width: 2, height: 1, offsetX: 0, offsetY: 0 });
    expect(Array.from(clip.data)).toEqual([2, 2, 2, 255, 3, 3, 3, 255]);
  });

  it("scales alpha by a soft selection (rgba8 rounds, rgba32f stays fractional)", () => {
    const mask = new Uint8Array(4 * 3);
    mask[1 * 4 + 1] = 128;
    mask[1 * 4 + 2] = 255;
    const clip = cropToClipboard(strip(), mask, 4, 3)!;
    expect(Array.from(clip.data)).toEqual([10, 20, 30, Math.round((255 * 128) / 255), 40, 50, 60, 200]);

    const f32: ClipboardSource = {
      format: "rgba32f",
      data: new Float32Array([2.5, 0.25, 0, 1]),
      width: 1,
      height: 1,
      offsetX: 0,
      offsetY: 0,
    };
    const fclip = cropToClipboard(f32, new Uint8Array([51]), 1, 1)!;
    expect(fclip.format).toBe("rgba32f");
    expect(fclip.data).toBeInstanceOf(Float32Array);
    expect(fclip.data[0]).toBe(2.5); // HDR colour kept
    expect(fclip.data[3]).toBeCloseTo(0.2, 6);
  });

  it("copies indexed pixels only where the selection is at least half on, padding with 255", () => {
    const src: ClipboardSource = {
      format: "indexed8",
      data: new Uint8Array([1, 2, 3, 255]),
      width: 4,
      height: 1,
      offsetX: 0,
      offsetY: 0,
      palette: PALETTE,
    };
    const clip = cropToClipboard(src, new Uint8Array([255, 127, 128, 255]), 4, 1)!;
    expect(clip.format).toBe("indexed8");
    expect(clip).toMatchObject({ width: 3, offsetX: 0 });
    expect(Array.from(clip.data)).toEqual([1, 255, 3]);
    expect(clip.format === "indexed8" && clip.palette).toEqual(PALETTE);
  });
});

describe("clipboardToRgba8", () => {
  it("encodes linear floats to sRGB bytes (no naive ×255) and clamps HDR", () => {
    const clip: ClipboardData = {
      format: "rgba32f",
      data: new Float32Array([0.5, 0.2158605, 4, 0.5]),
      width: 1,
      height: 1,
      offsetX: 0,
      offsetY: 0,
    };
    // linear 0.5 → sRGB 188; linear 0.2159 → sRGB 128; HDR 4 → 255.
    expect(Array.from(clipboardToRgba8(clip))).toEqual([188, 128, 255, 128]);
  });

  it("expands indexed pixels through the clip's palette", () => {
    const clip: ClipboardData = {
      format: "indexed8",
      data: new Uint8Array([1, 255]),
      palette: PALETTE,
      width: 2,
      height: 1,
      offsetX: 0,
      offsetY: 0,
    };
    expect(Array.from(clipboardToRgba8(clip))).toEqual([255, 0, 0, 255, 0, 0, 0, 0]);
  });

  it("returns rgba8 data as is", () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    expect(clipboardToRgba8({ format: "rgba8", data, width: 1, height: 1, offsetX: 0, offsetY: 0 })).toBe(data);
  });
});

describe("clipboardToFormat", () => {
  const rgbaClip = (data: Uint8Array): ClipboardData => ({ format: "rgba8", data, width: data.length / 4, height: 1, offsetX: 0, offsetY: 0 });

  it("indexed → indexed with the same palette is exact (incl. transparent 255)", async () => {
    const clip: ClipboardData = { format: "indexed8", data: new Uint8Array([0, 3, 255, 2]), palette: PALETTE, width: 4, height: 1, offsetX: 0, offsetY: 0 };
    expect(Array.from(await clipboardToFormat(clip, "indexed8", PALETTE))).toEqual([0, 3, 255, 2]);
  });

  it("indexed → indexed remaps changed entries to the nearest colour in the target palette", async () => {
    const target: RGBAColor[] = [
      { r: 250, g: 250, b: 250, a: 255 }, // ≈ white
      { r: 255, g: 0, b: 0, a: 255 }, // red, same index as source
      { r: 5, g: 5, b: 5, a: 255 }, // ≈ black
    ];
    const clip: ClipboardData = { format: "indexed8", data: new Uint8Array([0, 1, 3, 255]), palette: PALETTE, width: 4, height: 1, offsetX: 0, offsetY: 0 };
    expect(Array.from(await clipboardToFormat(clip, "indexed8", target))).toEqual([2, 1, 0, 255]);
  });

  it("rgba8 → indexed matches nearest colours; under half opacity becomes transparent", async () => {
    const data = new Uint8Array([250, 10, 10, 255, 10, 240, 10, 128, 255, 255, 255, 127]);
    expect(Array.from(await clipboardToFormat(rgbaClip(data), "indexed8", PALETTE))).toEqual([1, 2, 255]);
    // The clip itself isn't modified.
    expect(data[11]).toBe(127);
  });

  it("rgba8 → rgba32f decodes sRGB to linear", async () => {
    const out = (await clipboardToFormat(rgbaClip(new Uint8Array([128, 255, 0, 51])), "rgba32f", PALETTE)) as Float32Array;
    expect(out).toBeInstanceOf(Float32Array);
    expect(out[0]).toBeCloseTo(0.2158605, 6);
    expect(out[1]).toBe(1);
    expect(out[2]).toBe(0);
    expect(out[3]).toBeCloseTo(0.2, 6);
  });

  it("rgba32f → rgba8 → rgba32f round trip stays within 8-bit sRGB precision", async () => {
    const src = new Float32Array([0, 0.001, 0.05, 1, 0.18, 0.5, 0.9, 0.25, 1, 0.75, 0.33, 0]);
    const clip: ClipboardData = { format: "rgba32f", data: src, width: 3, height: 1, offsetX: 0, offsetY: 0 };
    const bytes = (await clipboardToFormat(clip, "rgba8", PALETTE)) as Uint8Array;
    const back = (await clipboardToFormat(rgbaClip(bytes), "rgba32f", PALETTE)) as Float32Array;
    for (let i = 0; i < src.length; i++) {
      // One 8-bit sRGB step is at most ~0.0084 in linear light (near 1.0).
      expect(Math.abs(back[i] - src[i])).toBeLessThanOrEqual(0.009);
    }
  });

  it("indexed → rgba32f goes through the clip palette and decodes to linear", async () => {
    const clip: ClipboardData = { format: "indexed8", data: new Uint8Array([3, 1]), palette: PALETTE, width: 2, height: 1, offsetX: 0, offsetY: 0 };
    expect(Array.from(await clipboardToFormat(clip, "rgba32f", []))).toEqual([1, 1, 1, 1, 1, 0, 0, 1]);
  });

  it("same format returns the data unchanged", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    expect(await clipboardToFormat(rgbaClip(data), "rgba8", PALETTE)).toBe(data);
  });
});
