import { describe, expect, it } from "vitest";
import { expandIndicesToRgba8 } from "@/graphics/webgpu/rendering/indexedColorExpand";

describe("expandIndicesToRgba8", () => {
  const palette = [
    { r: 10, g: 20, b: 30, a: 255 },
    { r: 200, g: 100, b: 50, a: 128 },
  ];

  it("maps each index to its palette colour", () => {
    expect(Array.from(expandIndicesToRgba8(new Uint8Array([1, 0]), palette))).toEqual([
      200, 100, 50, 128, 10, 20, 30, 255,
    ]);
  });

  it("renders the 255 sentinel and out-of-palette indices transparent", () => {
    expect(Array.from(expandIndicesToRgba8(new Uint8Array([255, 2, 0]), palette))).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 10, 20, 30, 255,
    ]);
    expect(Array.from(expandIndicesToRgba8(new Uint8Array([0]), []))).toEqual([0, 0, 0, 0]);
  });
});
