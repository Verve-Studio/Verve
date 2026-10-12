import { describe, expect, it } from "vitest";
import { stampCloneSegment } from "@/core/tools/CloneStamp/cloneStampStroke";
import { linearToSrgbChannel, srgbToLinearChannel } from "@/utils/pixelFormatConvert";
import { asRenderer, makeFakeRenderer, makeLayer, makeTouched, px } from "@tests/fakes/toolsPixelFakes";

const W = 16;
const H = 12;

/** Canvas-sized source whose pixel (x, y) = (10x, 10y, 7, 255) (or float equivalent). */
function source(float: boolean): Uint8Array | Float32Array {
  const buf = float ? new Float32Array(W * H * 4) : new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (float) buf.set([x * 0.5, y * 0.25, 2.5, 1], i);
      else buf.set([x * 10, y * 10, 7, 255], i);
    }
  return buf;
}

function clone(destFormat: "rgba8" | "rgba32f", src: Uint8Array | Float32Array, opts: { tiled?: boolean; dx?: number; dy?: number } = {}) {
  const r = makeFakeRenderer(W, H);
  const layer = makeLayer(destFormat, W, H);
  stampCloneSegment(
    asRenderer(r), layer, 8, 6, 8, 6, 5, 100, opts.dx ?? 3, opts.dy ?? -2, { kind: "canvas", data: src }, W, H, 100,
    makeTouched(W, H), undefined, opts.tiled ? W : undefined, opts.tiled ? H : undefined,
  );
  return layer;
}

describe("stampCloneSegment (canvas source)", () => {
  it("copies rgba8 source pixels from dest + offset exactly in the hard core", () => {
    const layer = clone("rgba8", source(false));
    expect(px(layer, 8, 6)).toEqual([110, 40, 7, 255]);
    expect(px(layer, 9, 7)).toEqual([120, 50, 7, 255]);
    expect(px(layer, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("f32 source -> f32 dest passes linear HDR values through", () => {
    const layer = clone("rgba32f", source(true));
    const [r, g, b, a] = px(layer, 8, 6);
    expect(r).toBeCloseTo(5.5, 6);
    expect(g).toBeCloseTo(1, 6);
    expect(b).toBeCloseTo(2.5, 6);
    expect(a).toBeCloseTo(1, 6);
  });

  it("f32 source -> rgba8 dest gamma-encodes and clamps", () => {
    const layer = clone("rgba8", source(true));
    const [r, g, b, a] = px(layer, 8, 6);
    expect(r).toBe(255); // 5.5 linear clamps
    expect(g).toBe(255);
    expect(b).toBe(255);
    expect(a).toBe(255);
    const l2 = clone("rgba8", source(true), { dx: -8, dy: -4 }); // source (0..,2) → 0, 0.5
    expect(px(l2, 8, 6)[1]).toBe(Math.round(linearToSrgbChannel(0.5) * 255));
  });

  it("rgba8 source -> f32 dest gamma-decodes", () => {
    const layer = clone("rgba32f", source(false));
    expect(px(layer, 8, 6)[0]).toBeCloseTo(srgbToLinearChannel(110 / 255), 6);
  });

  it("skips transparent / off-canvas source pixels, but wraps in tiled mode", () => {
    const off = clone("rgba8", source(false), { dx: 20 });
    expect(px(off, 8, 6)[3]).toBe(0);
    const tiled = clone("rgba8", source(false), { dx: 20, tiled: true });
    expect(px(tiled, 8, 6)).toEqual([(28 % W) * 10, 40, 7, 255]);
  });

  it("feathers soft edges", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H);
    stampCloneSegment(asRenderer(r), layer, 8, 6, 8, 6, 9, 0, 0, 0, { kind: "canvas", data: source(false) }, W, H, 100, makeTouched(W, H));
    const a = [0, 1, 2, 3, 4].map((d) => px(layer, 8 + d, 6)[3]);
    for (let i = 1; i < a.length; i++) expect(a[i]).toBeLessThanOrEqual(a[i - 1]);
    expect(a[4]).toBeLessThan(a[0]);
  });
});
