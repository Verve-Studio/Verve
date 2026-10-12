import { describe, expect, it } from "vitest";
import { eraseQuadBezier, eraseThickLine } from "@/core/tools/Eraser/eraseStroke";
import { srgbToLinearChannel } from "@/utils/pixelFormatConvert";
import { asRenderer, makeFakeRenderer, makeLayer, makeTouched, px } from "@tests/fakes/toolsPixelFakes";

const W = 20;
const H = 12;

describe("eraseThickLine — alpha mode", () => {
  it("full strength clears alpha in the footprint, keeps RGB, leaves the rest", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H, { fill: [10, 20, 30, 255] });
    eraseThickLine(asRenderer(r), layer, 10, 6, 10, 6, 5, 0, 0, 0, 100, true);
    expect(px(layer, 10, 6)).toEqual([10, 20, 30, 0]);
    expect(px(layer, 12, 6)).toEqual([10, 20, 30, 0]);
    expect(px(layer, 13, 6)).toEqual([10, 20, 30, 255]);
  });

  it("partial strength reduces alpha proportionally (rgba8 and rgba32f)", () => {
    const r = makeFakeRenderer(W, H);
    const a = makeLayer("rgba8", W, H, { fill: [0, 0, 0, 200] });
    const f = makeLayer("rgba32f", W, H, { fill: [0.5, 0.5, 0.5, 0.8] });
    eraseThickLine(asRenderer(r), a, 5, 5, 5, 5, 1, 0, 0, 0, 25, true);
    eraseThickLine(asRenderer(r), f, 5, 5, 5, 5, 1, 0, 0, 0, 25, true);
    expect(px(a, 5, 5)[3]).toBe(150);
    expect(px(f, 5, 5)[3]).toBeCloseTo(0.6, 6);
  });

  it("caps a stroke at its strength across overlapping segments", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba32f", W, H, { fill: [1, 1, 1, 1] });
    const touched = makeTouched(W, H);
    for (let i = 0; i < 5; i++) eraseThickLine(asRenderer(r), layer, 2, 6, 18, 6, 4, 0, 0, 0, 50, true, true, 0, touched);
    expect(px(layer, 10, 6)[3]).toBeCloseTo(0.5, 2);
  });
});

describe("eraseThickLine — background-colour mode", () => {
  it("lerps rgba8 RGB toward the secondary colour, keeping alpha", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H, { fill: [0, 0, 0, 77] });
    eraseThickLine(asRenderer(r), layer, 3, 3, 3, 3, 1, 200, 100, 50, 50, false);
    expect(px(layer, 3, 3)).toEqual([100, 50, 25, 77]);
  });

  it("gamma-decodes the 0–255 secondary colour for rgba32f layers", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba32f", W, H, { fill: [0, 0, 0, 1] });
    eraseThickLine(asRenderer(r), layer, 3, 3, 3, 3, 1, 128, 255, 0, 100, false);
    const [rr, gg, bb, aa] = px(layer, 3, 3);
    expect(rr).toBeCloseTo(srgbToLinearChannel(128 / 255), 6);
    expect(gg).toBeCloseTo(1, 6);
    expect(bb).toBe(0);
    expect(aa).toBe(1);
  });
});

describe("eraseThickLine — geometry", () => {
  it("anti-aliased segments feather the edge and fully erase the core", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H, { fill: [9, 9, 9, 255] });
    eraseThickLine(asRenderer(r), layer, 4, 6, 16, 6, 4, 0, 0, 0, 100, true, true, 0, makeTouched(W, H));
    expect(px(layer, 10, 6)[3]).toBe(0);
    const edge = px(layer, 10, 8)[3]; // radius 2 + 0.5 feather: dist 2 → half
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
    expect(px(layer, 10, 10)[3]).toBe(255);
  });

  it("softness fades the erase toward the rim", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H, { fill: [9, 9, 9, 255] });
    eraseThickLine(asRenderer(r), layer, 10, 6, 10, 6, 9, 0, 0, 0, 100, true, false, 100);
    const alphas = [0, 1, 2, 3, 4].map((d) => px(layer, 10 + d, 6)[3]);
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]).toBeGreaterThanOrEqual(alphas[i - 1]);
    expect(alphas[0]).toBe(0);
  });

  it("wraps in tiled mode", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H, { fill: [9, 9, 9, 255] });
    eraseThickLine(asRenderer(r), layer, -1, 3, -1, 3, 1, 0, 0, 0, 100, true, false, 0, undefined, undefined, W, H);
    expect(px(layer, W - 1, 3)[3]).toBe(0);
  });

  it("eraseQuadBezier ends exactly at both endpoints", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H, { fill: [9, 9, 9, 255] });
    eraseQuadBezier(asRenderer(r), layer, 2, 2, 10, 10, 17, 3, 1, 0, 0, 0, 100, true, false, 0, makeTouched(W, H));
    expect(px(layer, 2, 2)[3]).toBe(0);
    expect(px(layer, 17, 3)[3]).toBe(0);
  });
});

describe("eraseThickLine — selections", () => {
  it("does not erase outside the selection", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H, { fill: [9, 9, 9, 255] });
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 10; x < W; x++) mask[y * W + x] = 255;
    eraseThickLine(asRenderer(r), layer, 5, 6, 15, 6, 1, 0, 0, 0, 100, true, false, 0, undefined, { mask, width: W });
    expect(px(layer, 7, 6)[3]).toBe(255);
    expect(px(layer, 12, 6)[3]).toBe(0);
  });

  it("scales the erase by a soft (feathered) selection", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H, { fill: [9, 9, 9, 255] });
    const mask = new Uint8Array(W * H).fill(128);
    eraseThickLine(asRenderer(r), layer, 5, 6, 5, 6, 1, 0, 0, 0, 100, true, false, 0, undefined, { mask, width: W });
    expect(Math.abs(px(layer, 5, 6)[3] - 127)).toBeLessThanOrEqual(1);
  });

  it("scales the erase by a soft selection on rgba32f (unrounded)", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba32f", W, H, { fill: [0.5, 0.5, 0.5, 1] });
    const mask = new Uint8Array(W * H).fill(64);
    eraseThickLine(asRenderer(r), layer, 5, 6, 5, 6, 1, 0, 0, 0, 100, true, false, 0, undefined, { mask, width: W });
    expect(px(layer, 5, 6)[3]).toBeCloseTo(1 - 64 / 255, 6);
    expect(px(layer, 5, 6)[0]).toBeCloseTo(0.5, 6);
  });
});
