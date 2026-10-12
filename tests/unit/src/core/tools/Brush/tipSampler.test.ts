import { describe, expect, it } from "vitest";
import type { BrushTipShape } from "@/types";
import {
  dualProceduralCoverage,
  getCachedTipSampler,
  makeTipSampler,
  proceduralCoverage,
  sampleTipLevel,
  sweptRoundCoverage,
  tipLevelFor,
  type TipLevel,
} from "@/core/tools/Brush/tipSampler";

describe("proceduralCoverage", () => {
  const R = 10;
  const inv = 1 / R;

  it.each([0, 1, 2] as const)("tip %i: full at the centre, 0 well outside", (kind) => {
    expect(proceduralCoverage(kind, 0, 0, inv, inv, 0, true)).toBe(1);
    expect(proceduralCoverage(kind, 1.2, 0, inv, inv, 0, true)).toBe(0);
    expect(proceduralCoverage(kind, 0, 1.2, inv, inv, 0, false)).toBe(0);
  });

  it("hard AA edge is a 1 px box filter on the true pixel distance", () => {
    // Exactly on the silhouette: half covered.
    expect(proceduralCoverage(0, 1, 0, inv, inv, 0, true)).toBeCloseTo(0.5, 9);
    // 0.25 px inside / outside.
    expect(proceduralCoverage(0, 1 - 0.25 / R, 0, inv, inv, 0, true)).toBeCloseTo(0.75, 9);
    expect(proceduralCoverage(0, 1 + 0.25 / R, 0, inv, inv, 0, true)).toBeCloseTo(0.25, 9);
    expect(proceduralCoverage(0, 1 + 0.5 / R, 0, inv, inv, 0, true)).toBe(0);
    // Non-AA: binary.
    expect(proceduralCoverage(0, 0.999, 0, inv, inv, 0, false)).toBe(1);
    expect(proceduralCoverage(0, 1.001, 0, inv, inv, 0, false)).toBe(0);
  });

  it("square and diamond use their own metrics", () => {
    expect(proceduralCoverage(1, 0.9, 0.9, inv, inv, 0, false)).toBe(1);
    expect(proceduralCoverage(2, 0.6, 0.6, inv, inv, 0, false)).toBe(0);
    expect(proceduralCoverage(2, 0.4, 0.5, inv, inv, 0, false)).toBe(1);
  });

  it("soft tips fade out inside the radius with a smoothstep and never exceed 1", () => {
    let prev = 2;
    for (let u = 0; u <= 1.1; u += 0.01) {
      const c = proceduralCoverage(0, u, 0, inv, inv, 0.6, true);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
      expect(c).toBeLessThanOrEqual(prev + 1e-12);
      prev = c;
    }
    expect(proceduralCoverage(0, 0.3, 0, inv, inv, 0.6, true)).toBe(1); // inside the hard core
    expect(proceduralCoverage(0, 0.7, 0, inv, inv, 0.6, true)).toBeCloseTo(0.5 * 0.5 * (3 - 1), 9); // x = 0.5
  });

  it("low roundness keeps the thin side anti-aliased", () => {
    // Radius 10 along u, 2 along v: v = 1 is the edge, 0.25 px inside = 0.125 unit.
    const c = proceduralCoverage(0, 0, 1 - 0.25 / 2, inv, 1 / 2, 0, true);
    expect(c).toBeCloseTo(0.75, 2);
  });
});

describe("sweptRoundCoverage", () => {
  const inv = 1 / 8;
  it("with zero sweep equals the plain round tip", () => {
    for (const [u, v] of [[0, 0], [0.5, 0.3], [0.99, 0], [1.02, 0.1]])
      expect(sweptRoundCoverage(u, v, 0, 0, 1, inv, inv, 0.3, true)).toBeCloseTo(proceduralCoverage(0, u, v, inv, inv, 0.3, true), 9);
  });

  it("covers the whole segment from the previous centre, and nothing behind it", () => {
    // Segment start one radius to the left.
    expect(sweptRoundCoverage(-0.5, 0, -1, 0, 1, inv, inv, 0, true)).toBe(1);
    expect(sweptRoundCoverage(-0.5, 0.5, -1, 0, 1, inv, inv, 0, true)).toBe(1);
    expect(sweptRoundCoverage(-1.5, 0, -1, 0, 1, inv, inv, 0, true)).toBe(0);
  });
});

describe("dualProceduralCoverage", () => {
  it("is a hard 1 px AA silhouette", () => {
    expect(dualProceduralCoverage(0, 0, 0, 5)).toBe(1);
    expect(dualProceduralCoverage(0, 1, 0, 5)).toBeCloseTo(0.5, 12);
    expect(dualProceduralCoverage(1, 0.8, 0.8, 5)).toBe(1);
    expect(dualProceduralCoverage(2, 0.7, 0.7, 5)).toBe(0);
  });
});

describe("bitmap tips", () => {
  const rgbaFromAlpha = (w: number, h: number, a: (x: number, y: number) => number): Uint8Array => {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(y * w + x) * 4 + 3] = a(x, y);
    return out;
  };

  it("falls back to a round tip for missing or malformed data", () => {
    expect(makeTipSampler({ kind: "bitmap" }).tipKind).toBe(0);
    expect(makeTipSampler({ kind: "bitmap", bitmapRgba: new Uint8Array(12), bitmapWidth: 2, bitmapHeight: 2 }).tipKind).toBe(0);
    expect(makeTipSampler({ kind: "square" }).tipKind).toBe(1);
    expect(makeTipSampler({ kind: "diamond" }).tipKind).toBe(2);
  });

  it("uses alpha as density when the capture has transparency", () => {
    const s = makeTipSampler({ kind: "bitmap", bitmapRgba: rgbaFromAlpha(4, 4, (x) => (x < 2 ? 255 : 0)), bitmapWidth: 4, bitmapHeight: 4 });
    expect(s.tipKind).toBe(3);
    const l0 = s.levels![0];
    expect(Array.from(l0.data.slice(0, 4))).toEqual([1, 1, 0, 0]);
  });

  it("uses darkness as density for an opaque capture (black = full paint)", () => {
    const rgba = new Uint8Array(4 * 4).fill(255);
    rgba.set([0, 0, 0, 255], 0);
    const s = makeTipSampler({ kind: "bitmap", bitmapRgba: rgba, bitmapWidth: 2, bitmapHeight: 2 });
    expect(Array.from(s.levels![0].data)).toEqual([1, 0, 0, 0]);
  });

  it("builds a mip pyramid down to ≤ 2 px that preserves mean density", () => {
    const w = 37;
    const h = 20;
    const s = makeTipSampler({ kind: "bitmap", bitmapRgba: rgbaFromAlpha(w, h, (x, y) => ((x * 7 + y * 13) % 255)), bitmapWidth: w, bitmapHeight: h });
    const levels = s.levels!;
    const last = levels[levels.length - 1];
    expect(last.w <= 2 && last.h <= 2).toBe(true);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i].w).toBe(Math.ceil(levels[i - 1].w / 2));
      expect(levels[i].h).toBe(Math.ceil(levels[i - 1].h / 2));
    }
    // Even-sized level 0 → level 1 average is exact.
    const even = makeTipSampler({ kind: "bitmap", bitmapRgba: rgbaFromAlpha(8, 8, (x, y) => (x + y) * 10), bitmapWidth: 8, bitmapHeight: 8 }).levels!;
    const mean = (l: TipLevel) => l.data.reduce((a, b) => a + b, 0) / l.data.length;
    expect(mean(even[1])).toBeCloseTo(mean(even[0]), 6);
  });

  it("handles a 1×1 tip", () => {
    const s = makeTipSampler({ kind: "bitmap", bitmapRgba: new Uint8Array([0, 0, 0, 128]), bitmapWidth: 1, bitmapHeight: 1 });
    expect(s.levels).toHaveLength(1);
    expect(sampleTipLevel(s.levels![0], 0, 0)).toBeCloseTo(128 / 255, 6);
  });

  it("sampleTipLevel is bilinear inside and empty outside", () => {
    const level: TipLevel = { data: new Float32Array([0, 1, 1, 0]), w: 2, h: 2 };
    // Texel centres at u = ±0.5.
    expect(sampleTipLevel(level, -0.5, -0.5)).toBe(0);
    expect(sampleTipLevel(level, 0.5, -0.5)).toBe(1);
    expect(sampleTipLevel(level, 0, -0.5)).toBeCloseTo(0.5, 12);
    expect(sampleTipLevel(level, 0, 0)).toBeCloseTo(0.5, 12);
    expect(sampleTipLevel(level, 5, 0)).toBe(0);
    expect(sampleTipLevel(level, 0, -5)).toBe(0);
  });

  it("tipLevelFor picks the smallest level that covers the dab", () => {
    const lv = (n: number): TipLevel => ({ data: new Float32Array(n * n), w: n, h: n });
    const levels = [lv(64), lv(32), lv(16), lv(8), lv(4), lv(2)];
    expect(tipLevelFor(levels, 100).w).toBe(64);
    expect(tipLevelFor(levels, 64).w).toBe(64);
    expect(tipLevelFor(levels, 20).w).toBe(32);
    expect(tipLevelFor(levels, 16).w).toBe(16);
    expect(tipLevelFor(levels, 1).w).toBe(2);
  });

  it("getCachedTipSampler caches per shape object", () => {
    const shape: BrushTipShape = { kind: "bitmap", bitmapRgba: new Uint8Array(16 * 4).fill(255), bitmapWidth: 4, bitmapHeight: 4 };
    expect(getCachedTipSampler(shape)).toBe(getCachedTipSampler(shape));
    expect(getCachedTipSampler({ ...shape })).not.toBe(getCachedTipSampler(shape));
  });
});
