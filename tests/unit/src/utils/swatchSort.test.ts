import { describe, expect, it } from "vitest";
import type { RGBAColor, SwatchGroup } from "@/types";
import {
  dedupeSwatchesByRgba,
  mergeNearbySwatches,
  normalizePaletteForDisplay,
  rgbaToHsl,
  sortSwatchesByHue,
  swatchDisplayOrder,
} from "@/utils/swatchSort";

const c = (r: number, g: number, b: number, a = 255): RGBAColor => ({ r, g, b, a });

describe("rgbaToHsl", () => {
  it("converts primaries and greys", () => {
    expect(rgbaToHsl(c(255, 0, 0))).toEqual({ h: 0, s: 1, l: 0.5 });
    expect(rgbaToHsl(c(0, 255, 0)).h).toBeCloseTo(120, 9);
    expect(rgbaToHsl(c(0, 0, 255)).h).toBeCloseTo(240, 9);
    expect(rgbaToHsl(c(255, 0, 255)).h).toBeCloseTo(300, 9);
    const grey = rgbaToHsl(c(128, 128, 128));
    expect(grey.s).toBe(0);
    expect(grey.h).toBe(0);
    expect(grey.l).toBeCloseTo(128 / 255, 9);
  });

  it("keeps hue within [0, 360)", () => {
    for (let i = 0; i < 64; i++) {
      const { h } = rgbaToHsl(c((i * 37) % 256, (i * 91) % 256, (i * 13) % 256));
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});

describe("sortSwatchesByHue", () => {
  it("puts greys first (dark to light), then hues ascending, then transparent", () => {
    const input = [
      c(0, 0, 255), // blue 240
      c(255, 255, 255), // white
      c(0, 0, 0, 0), // transparent
      c(255, 0, 0), // red 0
      c(0, 0, 0), // black
      c(0, 255, 0), // green 120
    ];
    const out = sortSwatchesByHue(input).map((e) => e.canonicalIndex);
    expect(out).toEqual([4, 1, 3, 5, 0, 2]);
  });

  it("is a permutation that preserves canonical indices", () => {
    const input = Array.from({ length: 40 }, (_, i) => c((i * 53) % 256, (i * 97) % 256, (i * 29) % 256, i % 7 === 0 ? 0 : 255));
    const out = sortSwatchesByHue(input);
    expect(out.map((e) => e.canonicalIndex).sort((a, b) => a - b)).toEqual(input.map((_, i) => i));
    for (const e of out) expect(e.color).toBe(input[e.canonicalIndex]);
  });

  it("orders same-hue colours by saturation descending, then brightness", () => {
    const vivid = c(255, 0, 0);
    const muted = c(255, 128, 128);
    const dark = c(128, 0, 0);
    const out = sortSwatchesByHue([muted, dark, vivid]).map((e) => e.color);
    expect(out).toEqual([dark, vivid, muted]);
  });

  it("handles an empty palette", () => {
    expect(sortSwatchesByHue([])).toEqual([]);
  });
});

describe("palette dedupe / merge", () => {
  it("dedupes exact RGBA duplicates, first occurrence wins", () => {
    const a = c(200, 1, 2);
    const a2 = c(200, 1, 2);
    const b = c(200, 1, 2, 0);
    expect(dedupeSwatchesByRgba([a, a2, b, a])).toEqual([a, b]);
    expect(dedupeSwatchesByRgba([a, a2])[0]).toBe(a);
  });

  it("does not collide high-bit channel values", () => {
    const colors = [c(255, 0, 0), c(128, 0, 0), c(0, 255, 0), c(255, 255, 255, 255), c(255, 255, 255, 254)];
    expect(dedupeSwatchesByRgba(colors)).toHaveLength(5);
  });

  it("merges colours within the RGB threshold, but never across alpha", () => {
    const out = mergeNearbySwatches([c(100, 100, 100), c(103, 104, 100), c(100, 100, 100, 0), c(120, 100, 100)], 5);
    expect(out).toEqual([c(100, 100, 100), c(100, 100, 100, 0), c(120, 100, 100)]);
  });

  it("threshold 0 keeps distinct colours", () => {
    expect(mergeNearbySwatches([c(1, 1, 1), c(1, 1, 2)], 0)).toHaveLength(2);
  });

  it("normalizePaletteForDisplay dedupes then sorts", () => {
    const out = normalizePaletteForDisplay([c(0, 0, 255), c(255, 0, 0), c(0, 0, 255), c(0, 0, 0)]);
    expect(out).toEqual([c(0, 0, 0), c(255, 0, 0), c(0, 0, 255)]);
  });
});

describe("swatchDisplayOrder", () => {
  const swatches = [c(0, 0, 255), c(255, 0, 0), c(0, 255, 0), c(10, 10, 10), c(250, 250, 250)];

  it("without ramp groups is the hue sort with no row starts", () => {
    const out = swatchDisplayOrder(swatches, []);
    expect(out.map((e) => e.canonicalIndex)).toEqual(sortSwatchesByHue(swatches).map((e) => e.canonicalIndex));
    expect(out.every((e) => !e.rowStart)).toBe(true);
  });

  it("puts ramps first in stored order, then hue-sorts the rest", () => {
    const groups: SwatchGroup[] = [
      { id: "g", name: "ramp", swatchIndices: [2, 0], ramp: true },
      { id: "h", name: "plain", swatchIndices: [1] },
    ];
    const out = swatchDisplayOrder(swatches, groups);
    expect(out.map((e) => e.canonicalIndex)).toEqual([2, 0, 3, 4, 1]);
    expect(out.map((e) => e.rowStart)).toEqual([true, false, true, false, false]);
    for (const e of out) expect(e.color).toBe(swatches[e.canonicalIndex]);
  });

  it("ignores out-of-range and repeated ramp indices", () => {
    const groups: SwatchGroup[] = [
      { id: "a", name: "a", swatchIndices: [9, -1, 1], ramp: true },
      { id: "b", name: "b", swatchIndices: [1, 4], ramp: true },
    ];
    const out = swatchDisplayOrder(swatches, groups);
    const idx = out.map((e) => e.canonicalIndex);
    expect(idx.slice(0, 2)).toEqual([1, 4]);
    expect([...idx].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(out[0].rowStart && out[1].rowStart).toBe(true);
  });
});
