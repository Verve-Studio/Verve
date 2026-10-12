import { describe, expect, it } from "vitest";
import { OriginalPixels, dodgeBurnThickLine, type DodgeBurnRange } from "@/core/tools/Dodge/dodgeBurn";
import { convertRgba8ToF32, linearToSrgbChannel } from "@/utils/pixelFormatConvert";
import { asRenderer, makeFakeRenderer, makeLayer, makeTouched, px } from "@tests/fakes/toolsPixelFakes";

const W = 24;
const H = 16;

/** One hard dab of `size` at (cx, cy) on a uniform layer. */
function dab(
  format: "rgba8" | "rgba32f",
  fill: number[],
  exposure: number,
  range: DodgeBurnRange,
  opts: { size?: number; sel?: Uint8Array; touched?: boolean; aa?: boolean } = {},
) {
  const r = makeFakeRenderer(W, H);
  const layer = makeLayer(format, W, H, { fill });
  const touched = opts.touched === false ? undefined : makeTouched(W, H);
  const orig = new OriginalPixels(W);
  dodgeBurnThickLine(
    asRenderer(r), layer, 12, 8, 12, 8, opts.size ?? 5, exposure, range, 100, opts.aa ?? false, touched,
    opts.sel ? { mask: opts.sel, width: W } : undefined, orig,
  );
  return layer;
}

describe("dodge / burn tone ranges (rgba8)", () => {
  it("dodge lightens and burn darkens midtones; alpha is untouched", () => {
    const d = px(dab("rgba8", [128, 128, 128, 200], 0.5, "midtones"), 12, 8);
    const b = px(dab("rgba8", [128, 128, 128, 200], -0.5, "midtones"), 12, 8);
    expect(d[0]).toBeGreaterThan(128);
    expect(b[0]).toBeLessThan(128);
    expect(d[3]).toBe(200);
    expect(b[3]).toBe(200);
    // factor = 1 + exposure × weight; mid-grey weight ≈ 1.
    expect(d[0]).toBe(Math.round(128 * (1 + 0.5 * (1 - Math.abs(128 / 255 - 0.5) * 4))));
  });

  it("each range only affects its tones", () => {
    const dark = [20, 20, 20, 255];
    const light = [240, 240, 240, 255];
    expect(px(dab("rgba8", dark, 0.5, "highlights"), 12, 8)).toEqual(dark);
    expect(px(dab("rgba8", light, 0.5, "shadows"), 12, 8)).toEqual(light);
    expect(px(dab("rgba8", dark, 0.5, "shadows"), 12, 8)[0]).toBeGreaterThan(20);
    expect(px(dab("rgba8", light, -0.5, "highlights"), 12, 8)[0]).toBeLessThan(240);
  });

  it("clamps to 255 and leaves transparent pixels alone", () => {
    expect(px(dab("rgba8", [250, 250, 250, 255], 1, "highlights"), 12, 8)[0]).toBe(255);
    expect(px(dab("rgba8", [128, 128, 128, 0], 1, "midtones"), 12, 8)).toEqual([128, 128, 128, 0]);
  });

  it("only touches the dab footprint", () => {
    const layer = dab("rgba8", [128, 128, 128, 255], 0.5, "midtones", { size: 3 });
    expect(px(layer, 12 + 3, 8)).toEqual([128, 128, 128, 255]);
    expect(px(layer, 0, 0)).toEqual([128, 128, 128, 255]);
  });
});

describe("dodge / burn on rgba32f", () => {
  it("matches the rgba8 result for the same colour (classified in sRGB space)", () => {
    for (const [range, exposure, v] of [
      ["midtones", 0.4, 140],
      ["shadows", 0.6, 40],
      ["highlights", -0.5, 220],
    ] as const) {
      const b8 = px(dab("rgba8", [v, v - 10, v + 5, 255], exposure, range), 12, 8);
      const f = convertRgba8ToF32(new Uint8Array([v, v - 10, v + 5, 255]));
      const out = px(dab("rgba32f", Array.from(f), exposure, range), 12, 8);
      for (let c = 0; c < 3; c++) expect(Math.abs(linearToSrgbChannel(out[c]) * 255 - b8[c])).toBeLessThanOrEqual(1);
      expect(out[3]).toBeCloseTo(1, 6);
    }
  });

  it("does not clamp HDR values", () => {
    const out = px(dab("rgba32f", [4, 4, 4, 1], 0.5, "highlights"), 12, 8);
    expect(out[0]).toBeGreaterThan(4);
  });
});

describe("dodge / burn stroke semantics", () => {
  it("overlapping segments in one stroke apply once (touched + original pixels)", () => {
    const r = makeFakeRenderer(W, H);
    const once = makeLayer("rgba8", W, H, { fill: [120, 110, 100, 255] });
    const many = makeLayer("rgba8", W, H, { fill: [120, 110, 100, 255] });
    const t1 = makeTouched(W, H);
    const t2 = makeTouched(W, H);
    const o1 = new OriginalPixels(W);
    const o2 = new OriginalPixels(W);
    dodgeBurnThickLine(asRenderer(r), once, 4, 8, 20, 8, 5, 0.5, "midtones", 60, true, t1, undefined, o1);
    for (let i = 0; i < 3; i++) {
      dodgeBurnThickLine(asRenderer(r), many, 4, 8, 12, 8, 5, 0.5, "midtones", 60, true, t2, undefined, o2);
      dodgeBurnThickLine(asRenderer(r), many, 12, 8, 20, 8, 5, 0.5, "midtones", 60, true, t2, undefined, o2);
    }
    expect(Array.from(many.data)).toEqual(Array.from(once.data));
  });

  it("without a touched buffer repeated passes compound", () => {
    const layer = makeLayer("rgba8", W, H, { fill: [128, 128, 128, 255] });
    const r = makeFakeRenderer(W, H);
    dodgeBurnThickLine(asRenderer(r), layer, 12, 8, 12, 8, 3, 0.2, "midtones");
    const first = px(layer, 12, 8)[0];
    dodgeBurnThickLine(asRenderer(r), layer, 12, 8, 12, 8, 3, 0.2, "midtones");
    expect(px(layer, 12, 8)[0]).toBeGreaterThan(first);
  });

  it("soft selections scale the effect; unselected pixels are untouched", () => {
    const full = new Uint8Array(W * H).fill(255);
    const half = new Uint8Array(W * H).fill(128);
    const none = new Uint8Array(W * H);
    const a = px(dab("rgba8", [128, 128, 128, 255], 0.5, "midtones", { sel: full }), 12, 8)[0] - 128;
    const b = px(dab("rgba8", [128, 128, 128, 255], 0.5, "midtones", { sel: half }), 12, 8)[0] - 128;
    expect(b).toBeGreaterThan(0);
    expect(Math.abs(b - a * (128 / 255))).toBeLessThanOrEqual(1);
    expect(px(dab("rgba8", [128, 128, 128, 255], 0.5, "midtones", { sel: none }), 12, 8)[0]).toBe(128);
  });

  it("ignores off-canvas samples instead of wrapping onto the next row", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H, { fill: [128, 128, 128, 255] });
    dodgeBurnThickLine(asRenderer(r), layer, -1, 4, -1, 4, 1, 1, "midtones", 100, false, makeTouched(W, H));
    expect(px(layer, W - 1, 3)).toEqual([128, 128, 128, 255]);
  });
});
