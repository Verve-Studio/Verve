import { describe, expect, it } from "vitest";
import type { ColorDynamics, DynamicCurve, RGBAColor } from "@/types";
import { colorDynamicsInert, resolveStampColor } from "@/core/tools/Brush/colorJitter";
import { oklabToOklch, oklabToSrgb, oklchToOklab, srgbToOklab } from "@/core/tools/Brush/oklch";
import { identityCurve } from "@/core/tools/Brush/brushPreset";
import type { StampInputs } from "@/core/tools/Brush/dynamicsResolver";

const inputs = (over: Partial<StampInputs> = {}): StampInputs => ({
  pressure: 1,
  velocity: 0,
  tilt: 0,
  rotation: 0,
  direction: 0,
  stampIndex: 0,
  hash: 1,
  noiseSample: 0.5,
  ...over,
});

const inertDyn = (): ColorDynamics => ({
  fgBgJitter: identityCurve(),
  hueJitter: identityCurve(),
  saturationJitter: identityCurve(),
  brightnessJitter: identityCurve(),
  purityJitter: identityCurve(),
  perStamp: true,
});

const on = (source: DynamicCurve["source"], jitter = 1): DynamicCurve => ({ ...identityCurve(), source, jitter });

const FG: RGBAColor = { r: 0.8, g: 0.3, b: 0.1, a: 1 };
const BG: RGBAColor = { r: 0.1, g: 0.2, b: 0.9, a: 0.5 };

describe("OKLab helpers", () => {
  it("round-trip sRGB through OKLab and OKLCh, including HDR", () => {
    for (const [r, g, b] of [
      [0, 0, 0],
      [1, 1, 1],
      [0.2, 0.6, 0.9],
      [1, 0, 0],
      [2.5, 1.2, 0.3],
    ]) {
      const lab = srgbToOklab(r, g, b);
      const lch = oklabToOklch(lab.L, lab.a, lab.b);
      const back = oklchToOklab(lch.L, lch.C, lch.h);
      const rgb = oklabToSrgb(back.L, back.a, back.b);
      expect(rgb.r).toBeCloseTo(r, 4);
      expect(rgb.g).toBeCloseTo(g, 4);
      expect(rgb.b).toBeCloseTo(b, 4);
    }
  });

  it("white is L=1 with no chroma", () => {
    const w = srgbToOklab(1, 1, 1);
    expect(w.L).toBeCloseTo(1, 4);
    expect(Math.hypot(w.a, w.b)).toBeLessThan(1e-4);
  });
});

describe("colorDynamicsInert", () => {
  it("is true only when every dynamic is off or zero", () => {
    expect(colorDynamicsInert(inertDyn())).toBe(true);
    expect(colorDynamicsInert({ ...inertDyn(), hueJitter: on("random") })).toBe(false);
    expect(colorDynamicsInert({ ...inertDyn(), hueJitter: on("random", 0) })).toBe(true);
    expect(colorDynamicsInert({ ...inertDyn(), purityJitter: on("pressure") })).toBe(false);
  });
});

describe("resolveStampColor", () => {
  it("returns the primary unchanged when dynamics are inert", () => {
    const out = resolveStampColor(FG, BG, inertDyn(), inputs());
    expect(out.r).toBeCloseTo(FG.r, 5);
    expect(out.g).toBeCloseTo(FG.g, 5);
    expect(out.b).toBeCloseTo(FG.b, 5);
    expect(out.a).toBe(1);
  });

  it("preserves HDR primaries", () => {
    const hdr: RGBAColor = { r: 3, g: 1.5, b: 0.2, a: 1 };
    const out = resolveStampColor(hdr, BG, inertDyn(), inputs());
    expect(out.r).toBeCloseTo(3, 3);
    expect(out.g).toBeCloseTo(1.5, 3);
  });

  it("fg/bg jitter mixes towards the secondary (pressure 0 = full BG, incl. alpha)", () => {
    const dyn = { ...inertDyn(), fgBgJitter: on("pressure") };
    const full = resolveStampColor(FG, BG, dyn, inputs({ pressure: 0 }));
    expect(full.r).toBeCloseTo(BG.r, 4);
    expect(full.b).toBeCloseTo(BG.b, 4);
    expect(full.a).toBeCloseTo(0.5, 12);
    const none = resolveStampColor(FG, BG, dyn, inputs({ pressure: 1 }));
    expect(none.r).toBeCloseTo(FG.r, 4);
    expect(none.a).toBe(1);
  });

  it("purity at full strength produces a grey of the same OKLab lightness", () => {
    const dyn = { ...inertDyn(), purityJitter: on("pressure") };
    const out = resolveStampColor(FG, BG, dyn, inputs({ pressure: 0 }));
    expect(out.r).toBeCloseTo(out.g, 4);
    expect(out.g).toBeCloseTo(out.b, 4);
    expect(srgbToOklab(out.r, out.g, out.b).L).toBeCloseTo(srgbToOklab(FG.r, FG.g, FG.b).L, 4);
  });

  it("hue jitter rotates hue but keeps OKLab lightness (in-gamut colour)", () => {
    // Low chroma so the opposite hue stays inside sRGB (out-of-gamut results
    // are clipped per channel, which shifts lightness).
    const muted: RGBAColor = { r: 0.6, g: 0.5, b: 0.45, a: 1 };
    const dyn = { ...inertDyn(), hueJitter: on("pressure") };
    const out = resolveStampColor(muted, BG, dyn, inputs({ pressure: 1 }));
    const inL = srgbToOklab(muted.r, muted.g, muted.b);
    const outL = srgbToOklab(out.r, out.g, out.b);
    expect(outL.L).toBeCloseTo(inL.L, 4);
    // +π: the opposite hue.
    const hIn = Math.atan2(inL.b, inL.a);
    const hOut = Math.atan2(outL.b, outL.a);
    const wrapped = ((hOut - hIn + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    expect(Math.PI - Math.abs(wrapped)).toBeLessThan(0.05);
  });

  it("brightness jitter clamps LDR lightness to [0, 1]", () => {
    const grey: RGBAColor = { r: 0.5, g: 0.5, b: 0.5, a: 1 };
    const dyn = { ...inertDyn(), brightnessJitter: on("pressure") };
    const dark = resolveStampColor(grey, BG, dyn, inputs({ pressure: 0 }));
    expect(dark.r).toBeCloseTo(0, 4);
    const bright = resolveStampColor(grey, BG, dyn, inputs({ pressure: 1 }));
    expect(bright.r).toBeCloseTo(1, 4);
    expect(bright.g).toBeCloseTo(1, 4);
  });
});
