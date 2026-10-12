import { afterEach, describe, expect, it } from "vitest";
import type { RGBAColor, SwatchGroup } from "@/types";
import type { ToolContext } from "@/core/tools/_shared/types";
import { gradientOptions, gradientTool } from "@/core/tools/Gradient/Gradient";
import { linearToSrgbChannel, srgbToLinearChannel } from "@/utils/pixelFormatConvert";
import { asRenderer, makeFakeRenderer, makeLayer, px } from "@tests/fakes/toolsPixelFakes";

const W = 33;
const H = 5;
const defaults = { ...gradientOptions };

afterEach(() => {
  Object.assign(gradientOptions, defaults);
});

const BLACK: RGBAColor = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: RGBAColor = { r: 1, g: 1, b: 1, a: 1 };

function drag(
  layer: ReturnType<typeof makeLayer>,
  from: [number, number],
  to: [number, number],
  opts: { primary?: RGBAColor; secondary?: RGBAColor; selection?: Uint8Array | null; swatches?: RGBAColor[]; groups?: SwatchGroup[] } = {},
) {
  const renderer = makeFakeRenderer(W, H);
  const ctx = {
    renderer: asRenderer(renderer),
    layer,
    layers: [layer],
    primaryColor: opts.primary ?? BLACK,
    secondaryColor: opts.secondary ?? WHITE,
    selectionMask: opts.selection ?? null,
    render: () => {},
    growLayerToFit: () => {},
    overlayCanvas: null,
    swatches: opts.swatches ?? [],
    swatchGroups: opts.groups ?? [],
  } as unknown as ToolContext;
  const h = gradientTool.createHandler();
  const pos = (x: number, y: number) => ({ x, y, preciseX: x, preciseY: y, pressure: 1, timeStamp: 0 }) as never;
  h.onPointerDown?.(pos(...from), ctx);
  h.onPointerMove?.(pos(...to), ctx);
  h.onPointerUp?.(pos(...to), ctx);
  return renderer;
}

describe("gradient tool — rgba8", () => {
  it("interpolates primary → secondary along the drag in sRGB", () => {
    const layer = makeLayer("rgba8", W, H);
    drag(layer, [0, 2], [32, 2]);
    expect(px(layer, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(px(layer, 32, 4)).toEqual([255, 255, 255, 255]);
    expect(Math.abs(px(layer, 16, 2)[0] - 128)).toBeLessThanOrEqual(1);
    for (let x = 1; x < W; x++) expect(px(layer, x, 1)[0]).toBeGreaterThanOrEqual(px(layer, x - 1, 1)[0]);
  });

  it("clamps before the start and after the end ('none' repeat)", () => {
    const layer = makeLayer("rgba8", W, H);
    drag(layer, [10, 0], [20, 0]);
    expect(px(layer, 0, 0)[0]).toBe(0);
    expect(px(layer, 32, 0)[0]).toBe(255);
  });

  it("repeat and reflect wrap t", () => {
    gradientOptions.repeat = "repeat";
    const a = makeLayer("rgba8", W, H);
    drag(a, [0, 0], [10, 0]);
    expect(px(a, 15, 0)[0]).toBe(px(a, 5, 0)[0]);
    gradientOptions.repeat = "reflect";
    const b = makeLayer("rgba8", W, H);
    drag(b, [0, 0], [10, 0]);
    expect(px(b, 15, 0)[0]).toBe(px(b, 5, 0)[0]);
    expect(px(b, 12, 0)[0]).toBe(px(b, 8, 0)[0]);
    expect(px(b, 20, 0)[0]).toBe(0);
  });

  it("radial gradients depend on distance only", () => {
    gradientOptions.type = "radial";
    const layer = makeLayer("rgba8", W, H);
    drag(layer, [16, 2], [26, 2]);
    expect(px(layer, 16, 2)[0]).toBe(0);
    expect(px(layer, 13, 2)[0]).toBe(px(layer, 19, 2)[0]);
    expect(px(layer, 16, 0)[0]).toBe(px(layer, 18, 2)[0]);
  });

  it("composites over existing pixels at the tool opacity", () => {
    gradientOptions.opacity = 50;
    const layer = makeLayer("rgba8", W, H, { fill: [255, 0, 0, 255] });
    drag(layer, [0, 0], [32, 0], { primary: { r: 0, g: 0, b: 1, a: 1 }, secondary: { r: 0, g: 0, b: 1, a: 1 } });
    expect(px(layer, 5, 2)).toEqual([128, 0, 128, 255]);
  });

  it("skips unselected pixels", () => {
    const sel = new Uint8Array(W * H);
    sel.fill(255, 0, W); // first row only
    const layer = makeLayer("rgba8", W, H);
    drag(layer, [0, 0], [32, 0], { selection: sel });
    expect(px(layer, 32, 0)[3]).toBe(255);
    expect(px(layer, 32, 1)[3]).toBe(0);
  });

  it("scales by a soft selection", () => {
    const sel = new Uint8Array(W * H).fill(128);
    const layer = makeLayer("rgba8", W, H);
    drag(layer, [0, 0], [32, 0], { selection: sel });
    expect(Math.abs(px(layer, 32, 0)[3] - 128)).toBeLessThanOrEqual(1);
  });
});

describe("gradient tool — rgba32f", () => {
  it("stores linear light and matches the rgba8 result after encoding", () => {
    const f = makeLayer("rgba32f", W, H);
    const b = makeLayer("rgba8", W, H);
    drag(f, [0, 0], [32, 0]);
    drag(b, [0, 0], [32, 0]);
    for (let x = 0; x < W; x++) {
      const lin = px(f, x, 0)[0];
      expect(Math.abs(linearToSrgbChannel(lin) * 255 - px(b, x, 0)[0])).toBeLessThanOrEqual(1);
    }
    expect(px(f, 16, 0)[0]).toBeCloseTo(srgbToLinearChannel(0.5), 2);
    expect(px(f, 16, 0)[3]).toBe(1);
  });

  it("scales by a soft selection in linear light", () => {
    const sel = new Uint8Array(W * H).fill(64);
    const f = makeLayer("rgba32f", W, H);
    drag(f, [0, 0], [32, 0], { selection: sel });
    expect(px(f, 32, 0)[3]).toBeCloseTo(64 / 255, 5);
    expect(px(f, 32, 0)[0]).toBeCloseTo(1, 5); // colour is not darkened
  });

  it("keeps HDR primaries above 1", () => {
    const f = makeLayer("rgba32f", W, H);
    drag(f, [0, 0], [32, 0], { primary: { r: 4, g: 4, b: 4, a: 1 }, secondary: { r: 4, g: 4, b: 4, a: 1 } });
    expect(px(f, 10, 0)[0]).toBeCloseTo(srgbToLinearChannel(4), 4);
    const b = makeLayer("rgba8", W, H);
    drag(b, [0, 0], [32, 0], { primary: { r: 4, g: 4, b: 4, a: 1 }, secondary: { r: 4, g: 4, b: 4, a: 1 } });
    expect(px(b, 10, 0)[0]).toBe(255);
  });
});

describe("gradient tool — indexed8", () => {
  const swatches: RGBAColor[] = [
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 80, g: 80, b: 80, a: 255 },
    { r: 160, g: 160, b: 160, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 },
  ];
  const groups: SwatchGroup[] = [{ id: "g", name: "ramp", swatchIndices: [0, 1, 2, 3, 255, 99] }];

  it("walks the group's valid indices in stripes (no sentinel, no stale indices)", () => {
    gradientOptions.paletteGroupId = "g";
    const layer = makeLayer("indexed8", W, H);
    drag(layer, [0, 0], [32, 0], { swatches, groups });
    const row = Array.from(layer.data.subarray(0, W));
    expect(row[0]).toBe(0);
    expect(row[W - 1]).toBe(3);
    expect(new Set(row)).toEqual(new Set([0, 1, 2, 3]));
    for (let x = 1; x < W; x++) expect(row[x]).toBeGreaterThanOrEqual(row[x - 1]);
    expect(Array.from(layer.data).every((v) => v <= 3)).toBe(true);
  });

  it("reverse direction flips the ramp", () => {
    gradientOptions.paletteGroupId = "g";
    gradientOptions.direction = "reverse";
    const layer = makeLayer("indexed8", W, H);
    drag(layer, [0, 0], [32, 0], { swatches, groups });
    expect(layer.data[0]).toBe(3);
    expect(layer.data[W - 1]).toBe(0);
  });

  it("keeps existing indices outside the selection", () => {
    gradientOptions.paletteGroupId = "g";
    const layer = makeLayer("indexed8", W, H, { fill: [2] });
    const sel = new Uint8Array(W * H);
    sel.fill(255, W, 2 * W); // row 1 only
    drag(layer, [0, 0], [32, 0], { swatches, groups, selection: sel });
    expect(layer.data[0]).toBe(2);
    expect(layer.data[W]).toBe(0);
    expect(layer.data[3 * W + 30]).toBe(2);
  });

  it("thresholds a soft selection at 50%", () => {
    gradientOptions.paletteGroupId = "g";
    const layer = makeLayer("indexed8", W, H, { fill: [2] });
    const sel = new Uint8Array(W * H);
    sel.fill(127, 0, W); // row 0: just under half
    sel.fill(128, W, 2 * W); // row 1: half
    drag(layer, [0, 0], [32, 0], { swatches, groups, selection: sel });
    expect(layer.data[0]).toBe(2);
    expect(layer.data[W]).toBe(0);
  });

  it("does nothing without a usable group", () => {
    const layer = makeLayer("indexed8", W, H, { fill: [1] });
    drag(layer, [0, 0], [32, 0], { swatches, groups: [{ id: "x", name: "x", swatchIndices: [2] }] });
    expect(Array.from(layer.data).every((v) => v === 1)).toBe(true);
  });
});
