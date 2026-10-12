import { describe, expect, it } from "vitest";
import { floatToHalf16 } from "@/graphics/webgpu/resources/halfFloat";

describe("floatToHalf16", () => {
  it.each([
    [0, 0x0000],
    [-0, 0x8000],
    [1, 0x3c00],
    [0.5, 0x3800],
    [-2, 0xc000],
    [65504, 0x7bff], // largest finite half
    [2 ** -14, 0x0400], // smallest normal half
  ])("encodes %f exactly", (v, bits) => {
    expect(floatToHalf16(v)).toBe(bits);
  });

  it("saturates overflow to ±infinity and keeps NaN a NaN", () => {
    expect(floatToHalf16(1e6)).toBe(0x7c00);
    expect(floatToHalf16(-1e6)).toBe(0xfc00);
    expect(floatToHalf16(Infinity)).toBe(0x7c00);
    const nan = floatToHalf16(NaN);
    expect(nan & 0x7c00).toBe(0x7c00);
    expect(nan & 0x03ff).not.toBe(0);
  });

  it("flushes values below the normal range to signed zero", () => {
    expect(floatToHalf16(1e-8)).toBe(0);
    expect(floatToHalf16(-1e-8)).toBe(0x8000);
  });

  it("is monotonic over [0, 1] (identity LUT ramps stay ordered)", () => {
    let prev = -1;
    for (let i = 0; i <= 64; i++) {
      const h = floatToHalf16(i / 64);
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
  });
});
