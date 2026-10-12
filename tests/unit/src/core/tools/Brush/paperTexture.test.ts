import { describe, expect, it } from "vitest";
import { applyGrain, grainNoise } from "@/core/tools/Brush/paperTexture";

describe("grainNoise", () => {
  it("is deterministic and in [0, 1]", () => {
    for (let y = -20; y < 40; y += 3)
      for (let x = -20; x < 40; x += 3)
        for (const s of [1, 2, 8, 64]) {
          const n = grainNoise(x, y, s);
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThanOrEqual(1);
          expect(grainNoise(x, y, s)).toBe(n);
        }
  });

  it("clamps scale below 2", () => {
    expect(grainNoise(5.5, 3.25, 0.5)).toBe(grainNoise(5.5, 3.25, 2));
  });

  it("spans most of the range (contrast stretch) and varies spatially", () => {
    let lo = 1;
    let hi = 0;
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        const n = grainNoise(x, y, 16);
        lo = Math.min(lo, n);
        hi = Math.max(hi, n);
      }
    expect(lo).toBeLessThan(0.15);
    expect(hi).toBeGreaterThan(0.85);
  });

  it("larger scales are smoother (smaller neighbour differences)", () => {
    const roughness = (scale: number): number => {
      let d = 0;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) d += Math.abs(grainNoise(x + 1, y, scale) - grainNoise(x, y, scale));
      return d;
    };
    expect(roughness(64)).toBeLessThan(roughness(4));
  });
});

describe("applyGrain", () => {
  it("is the identity at amount 0 or on a paper peak", () => {
    expect(applyGrain(0.7, 0.2, 0, false, 1)).toBe(0.7);
    expect(applyGrain(0.7, 1, 0.9, false, 1)).toBe(0.7);
    expect(applyGrain(0.7, 1, 0.9, true, 3)).toBe(0.7);
  });

  it("multiply scales coverage by 1 − amount·(1 − n)", () => {
    expect(applyGrain(0.8, 0.25, 0.4, false, 1)).toBeCloseTo(0.8 * (1 - 0.4 * 0.75), 12);
  });

  it("subtract removes a fixed depth relative to the paint alpha and never goes negative", () => {
    // Dense paint (alpha 1): depth 0.3 removed.
    expect(applyGrain(0.9, 0.5, 0.6, true, 1)).toBeCloseTo(0.6, 12);
    // Faint paint (alpha 0.25): the same tooth removes 4× as much coverage.
    expect(applyGrain(0.9, 0.5, 0.6, true, 4)).toBe(0);
  });
});
