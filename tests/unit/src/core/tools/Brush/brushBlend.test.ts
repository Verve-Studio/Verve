import { describe, expect, it } from "vitest";
import {
  BM_BEHIND,
  BM_CLEAR,
  BM_NORMAL,
  BRUSH_BLEND_MODES,
  blendModeId,
  blendRgb,
  compositeStroke,
  type BrushBlendMode,
} from "@/core/tools/Brush/brushBlend";

const id = (m: BrushBlendMode): number => blendModeId(m);
const blend = (mode: BrushBlendMode, b: number[], s: number[]): number[] => {
  const out = [...s];
  blendRgb(id(mode), b, out);
  return out;
};
const lum = (c: number[]): number => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

describe("mode ids", () => {
  it("ids are unique and match the exported constants (kernel contract)", () => {
    const ids = BRUSH_BLEND_MODES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(blendModeId("normal")).toBe(BM_NORMAL);
    expect(blendModeId("behind")).toBe(BM_BEHIND);
    expect(blendModeId("clear")).toBe(BM_CLEAR);
    expect(blendModeId(undefined)).toBe(0);
    expect(blendModeId("bogus" as BrushBlendMode)).toBe(0);
    BRUSH_BLEND_MODES.forEach((m, i) => expect(blendModeId(m.id)).toBe(i));
  });
});

describe("separable blend modes (W3C formulas)", () => {
  const b = [0.2, 0.5, 0.8];
  const s = [0.6, 0.5, 0.1];

  it.each([
    ["multiply", (x: number, y: number) => x * y],
    ["screen", (x: number, y: number) => x + y - x * y],
    ["darken", Math.min],
    ["lighten", Math.max],
    ["difference", (x: number, y: number) => Math.abs(x - y)],
    ["exclusion", (x: number, y: number) => x + y - 2 * x * y],
    ["overlay", (x: number, y: number) => (x <= 0.5 ? 2 * x * y : 1 - 2 * (1 - x) * (1 - y))],
    ["hard-light", (x: number, y: number) => (y <= 0.5 ? 2 * x * y : 1 - 2 * (1 - x) * (1 - y))],
  ] as const)("%s", (mode, f) => {
    const out = blend(mode, b, s);
    for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(f(b[i], s[i]), 12);
  });

  it("normal returns the source", () => {
    expect(blend("normal", b, s)).toEqual(s);
  });

  it("color dodge / burn edge cases", () => {
    expect(blend("color-dodge", [0, 0.5, 0.5], [0.5, 1, 0.5])).toEqual([0, 1, 1]);
    expect(blend("color-burn", [1, 0.5, 0.5], [0.5, 0, 1])).toEqual([1, 0, 0.5]);
  });

  it("soft light with mid-grey source is the identity", () => {
    const out = blend("soft-light", b, [0.5, 0.5, 0.5]);
    for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(b[i], 12);
  });

  it("all modes keep LDR inputs within [0, 1]", () => {
    for (const { id: mode } of BRUSH_BLEND_MODES) {
      if (mode === "behind" || mode === "clear") continue;
      for (const bv of [0, 0.1, 0.5, 0.9, 1])
        for (const sv of [0, 0.25, 0.5, 0.75, 1]) {
          const out = blend(mode, [bv, 1 - bv, bv * 0.5], [sv, 0.3, 1 - sv]);
          for (const v of out) {
            expect(v, mode).toBeGreaterThanOrEqual(-1e-9);
            expect(v, mode).toBeLessThanOrEqual(1 + 1e-9);
          }
        }
    }
  });
});

describe("non-separable modes", () => {
  const backdrop = [0.2, 0.4, 0.6];
  const src = [0.9, 0.1, 0.3];

  it("luminosity keeps the source luminance", () => {
    expect(lum(blend("luminosity", backdrop, src))).toBeCloseTo(lum(src), 9);
  });

  it("color / hue / saturation keep the backdrop luminance", () => {
    for (const m of ["color", "hue", "saturation"] as const) expect(lum(blend(m, backdrop, src))).toBeCloseTo(lum(backdrop), 9);
  });

  it("saturation over a grey backdrop stays that grey", () => {
    const grey = [0.5, 0.5, 0.5];
    expect(blend("saturation", grey, src)).toEqual([0.5, 0.5, 0.5].map((v) => expect.closeTo(v, 9)));
  });
});

describe("compositeStroke", () => {
  const out = [0, 0, 0, 0];

  it("normal over transparent = source", () => {
    compositeStroke(BM_NORMAL, [0, 0, 0], 0, [0.3, 0.6, 0.9], 0.4, out);
    expect(out.map((v) => +v.toFixed(9))).toEqual([0.3, 0.6, 0.9, 0.4]);
  });

  it("normal is Porter-Duff over", () => {
    compositeStroke(BM_NORMAL, [1, 0, 0], 1, [0, 0, 1], 0.25, out);
    expect(out[0]).toBeCloseTo(0.75, 12);
    expect(out[2]).toBeCloseTo(0.25, 12);
    expect(out[3]).toBeCloseTo(1, 12);
  });

  it("multiply over an opaque backdrop equals the blend formula lerped by alpha", () => {
    compositeStroke(blendModeId("multiply"), [0.8, 0.5, 0.2], 1, [0.5, 0.5, 0.5], 0.5, out);
    expect(out[0]).toBeCloseTo(0.8 * 0.5 + 0.4 * 0.5, 12);
    expect(out[3]).toBe(1);
  });

  it("blend modes act like normal over transparent pixels", () => {
    compositeStroke(blendModeId("multiply"), [0.8, 0.5, 0.2], 0, [0.1, 0.2, 0.3], 0.6, out);
    expect(out.map((v) => +v.toFixed(9))).toEqual([0.1, 0.2, 0.3, 0.6]);
  });

  it("behind only fills transparency", () => {
    compositeStroke(BM_BEHIND, [0.2, 0.3, 0.4], 1, [1, 1, 1], 1, out);
    expect(out.map((v) => +v.toFixed(9))).toEqual([0.2, 0.3, 0.4, 1]);
    compositeStroke(BM_BEHIND, [0.2, 0.3, 0.4], 0, [1, 0, 1], 0.5, out);
    expect(out.map((v) => +v.toFixed(9))).toEqual([1, 0, 1, 0.5]);
  });

  it("clear erases by stroke alpha, keeping colour", () => {
    compositeStroke(BM_CLEAR, [0.2, 0.3, 0.4], 0.8, [1, 1, 1], 0.5, out);
    expect(out[3]).toBeCloseTo(0.4, 12);
    expect(out[0]).toBeCloseTo(0.2, 12);
    compositeStroke(BM_CLEAR, [0.2, 0.3, 0.4], 1, [1, 1, 1], 1, out);
    expect(out).toEqual([0, 0, 0, 0]);
  });

  it("alpha never exceeds 1 and is monotone in stroke alpha (non-clear modes)", () => {
    for (const { id: mode } of BRUSH_BLEND_MODES) {
      if (mode === "clear") continue;
      let prev = -1;
      for (let as = 0; as <= 1; as += 0.1) {
        compositeStroke(blendModeId(mode), [0.4, 0.4, 0.4], 0.5, [0.9, 0.1, 0.5], as, out);
        expect(out[3]).toBeLessThanOrEqual(1 + 1e-12);
        expect(out[3]).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = out[3];
      }
    }
  });

  it("keeps HDR values unclamped in normal mode", () => {
    compositeStroke(BM_NORMAL, [0, 0, 0], 1, [6, 3, 1.5], 1, out);
    expect(out.slice(0, 3)).toEqual([6, 3, 1.5]);
  });
});
