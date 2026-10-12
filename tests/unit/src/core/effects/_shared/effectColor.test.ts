import { describe, expect, it } from "vitest";
import { colorForTarget, isLinearTarget } from "@/core/effects/_shared/effectColor";

describe("isLinearTarget", () => {
  it("is true only for float render targets", () => {
    expect(isLinearTarget("rgba16float")).toBe(true);
    expect(isLinearTarget("rgba32float")).toBe(true);
    expect(isLinearTarget("rgba8unorm")).toBe(false);
    expect(isLinearTarget("bgra8unorm")).toBe(false);
    expect(isLinearTarget("rgba8unorm-srgb")).toBe(false);
  });
});

describe("colorForTarget", () => {
  const c = { r: 255, g: 128, b: 0, a: 128 };

  it("normalises sRGB bytes to 0–1 on 8-bit targets without changing the transfer", () => {
    const out = colorForTarget(c, "rgba8unorm");
    expect(out.r).toBe(1);
    expect(out.g).toBeCloseTo(128 / 255, 10);
    expect(out.b).toBe(0);
    expect(out.a).toBeCloseTo(128 / 255, 10);
  });

  it.each(["rgba16float", "rgba32float"] as const)("gamma-decodes RGB (not alpha) on %s", (fmt) => {
    const out = colorForTarget(c, fmt);
    expect(out.r).toBeCloseTo(1, 10);
    expect(out.b).toBe(0);
    // sRGB 128 ≈ 0.2158 linear — not the naive 128/255 ≈ 0.502.
    expect(out.g).toBeCloseTo(0.21586, 4);
    // Alpha is linear in both encodings.
    expect(out.a).toBeCloseTo(128 / 255, 10);
  });

  it("is continuous and monotonic across the sRGB toe", () => {
    let prev = -1;
    for (let v = 0; v <= 255; v++) {
      const g = colorForTarget({ r: 0, g: v, b: 0, a: 255 }, "rgba32float").g;
      expect(g).toBeGreaterThan(prev);
      prev = g;
    }
    // Linear segment: 10/255 = 0.0392 < 0.04045 → c / 12.92.
    expect(colorForTarget({ r: 10, g: 0, b: 0, a: 255 }, "rgba32float").r).toBeCloseTo(10 / 255 / 12.92, 10);
  });
});
