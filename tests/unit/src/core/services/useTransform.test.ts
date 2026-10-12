import { describe, expect, it } from "vitest";
import { cropForTransform } from "@/core/services/useTransform";

const rect = { x: 0, y: 0, w: 3, h: 1 };

describe("cropForTransform (free-transform lift)", () => {
  it("rgba8: lifts alpha × mask / 255 (soft selections lift part of the pixel)", () => {
    const src = new Uint8Array([10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 200]);
    const out = cropForTransform(src, "rgba8", 3, rect, new Uint8Array([0, 128, 255]));
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 10, 20, 30, 128, 10, 20, 30, 200]);
  });

  it("rgba32f: unrounded alpha, HDR colour kept", () => {
    const src = new Float32Array([4, 0.5, 0, 1, 4, 0.5, 0, 1, 4, 0.5, 0, 1]);
    const out = cropForTransform(src, "rgba32f", 3, rect, new Uint8Array([64, 255, 0]));
    expect(out[0]).toBe(4);
    expect(out[3]).toBeCloseTo(64 / 255, 6);
    expect(out[7]).toBe(1);
    expect(out[11]).toBe(0);
  });

  it("indexed8: thresholds the mask at 50% and skips the transparent sentinel", () => {
    const src = new Uint8Array([3, 3, 255]);
    const out = cropForTransform(src, "indexed8", 3, rect, new Uint8Array([127, 128, 255]));
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 3, 0, 0, 255, 0, 0, 0, 0]);
  });

  it("without a selection lifts everything", () => {
    const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(Array.from(cropForTransform(src, "rgba8", 3, rect, null))).toEqual(Array.from(src));
  });
});
