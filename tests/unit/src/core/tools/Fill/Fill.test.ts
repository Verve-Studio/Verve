import { beforeAll, describe, expect, it } from "vitest";
import type { RGBAColor } from "@/types";
import type { ToolContext } from "@/core/tools/_shared/types";
import { activeScope } from "@/core/store/scope";
import { getPixelOps } from "@/wasm";
import { fillTool } from "@/core/tools/Fill/Fill";
import { srgbToLinearChannel } from "@/utils/pixelFormatConvert";
import { asRenderer, makeFakeRenderer, makeLayer, px } from "@tests/fakes/toolsPixelFakes";

const W = 8;
const H = 6;

beforeAll(async () => {
  await getPixelOps();
});

/** Left half (x < 4) one colour, right half another. */
function twoRegions(format: "rgba8" | "rgba32f" | "indexed8") {
  const layer = makeLayer(format, W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const left = x < 4;
      if (format === "indexed8") layer.data[y * W + x] = left ? 0 : 1;
      else if (format === "rgba32f") layer.data.set(left ? [0.1, 0.1, 0.1, 1] : [0.9, 0.9, 0.9, 1], (y * W + x) * 4);
      else layer.data.set(left ? [20, 20, 20, 255] : [230, 230, 230, 255], (y * W + x) * 4);
    }
  return layer;
}

/** Click with the fill tool; resolves once the fill committed. */
async function click(
  layer: ReturnType<typeof makeLayer>,
  x: number,
  y: number,
  primary: RGBAColor,
  opts: { selection?: Uint8Array | null; swatches?: RGBAColor[] } = {},
): Promise<void> {
  const renderer = makeFakeRenderer(W, H);
  let done!: () => void;
  const committed = new Promise<void>((r) => (done = r));
  const ctx = {
    scope: activeScope(),
    renderer: asRenderer(renderer),
    layer,
    layers: [layer],
    primaryColor: primary,
    selectionMask: opts.selection ?? null,
    render: () => {},
    commitStroke: () => done(),
    growLayerToFit: () => {},
    swatches: opts.swatches ?? [],
  } as unknown as ToolContext;
  fillTool.createHandler().onPointerDown?.({ x, y, preciseX: x, preciseY: y, pressure: 1, timeStamp: 0 } as never, ctx);
  await Promise.race([committed, new Promise((_, rej) => setTimeout(() => rej(new Error("fill never committed")), 2000))]);
}

const RED: RGBAColor = { r: 1, g: 0, b: 0, a: 1 };

describe("fill tool (contiguous)", () => {
  it("rgba8: fills only the clicked region with the primary colour", async () => {
    const layer = twoRegions("rgba8");
    await click(layer, 1, 1, RED);
    expect(px(layer, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(layer, 3, 5)).toEqual([255, 0, 0, 255]);
    expect(px(layer, 4, 0)).toEqual([230, 230, 230, 255]);
  });

  it("rgba32f: fills with linear light, HDR primaries stay above 1", async () => {
    const layer = twoRegions("rgba32f");
    await click(layer, 6, 2, { r: 0.5, g: 3, b: 0, a: 1 });
    const [r, g, b, a] = px(layer, 7, 5);
    expect(r).toBeCloseTo(srgbToLinearChannel(0.5), 5);
    expect(g).toBeCloseTo(srgbToLinearChannel(3), 4);
    expect(g).toBeGreaterThan(1);
    expect(b).toBe(0);
    expect(a).toBe(1);
    expect(px(layer, 0, 0)[0]).toBeCloseTo(0.1, 6);
  });

  it("indexed8: writes the nearest palette index, never blends", async () => {
    const swatches: RGBAColor[] = [
      { r: 20, g: 20, b: 20, a: 255 },
      { r: 230, g: 230, b: 230, a: 255 },
      { r: 250, g: 10, b: 0, a: 255 },
    ];
    const layer = twoRegions("indexed8");
    await click(layer, 1, 1, RED, { swatches });
    const row = Array.from(layer.data.subarray(0, W));
    expect(row).toEqual([2, 2, 2, 2, 1, 1, 1, 1]);
  });

  it("keeps pixels outside the selection", async () => {
    const sel = new Uint8Array(W * H);
    sel.fill(255, 0, 2 * W); // top two rows
    const layer = twoRegions("rgba8");
    await click(layer, 1, 1, RED, { selection: sel });
    expect(px(layer, 1, 1)).toEqual([255, 0, 0, 255]);
    expect(px(layer, 1, 4)).toEqual([20, 20, 20, 255]);
  });

  it("indexed8 keeps indices outside the selection", async () => {
    const sel = new Uint8Array(W * H);
    sel.fill(255, 0, W);
    const layer = twoRegions("indexed8");
    await click(layer, 1, 0, RED, { selection: sel, swatches: [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }, { r: 255, g: 0, b: 0, a: 255 }] });
    expect(layer.data[0]).toBe(2);
    expect(layer.data[W]).toBe(0);
  });

  it("blends the fill by a soft selection", async () => {
    const sel = new Uint8Array(W * H).fill(128);
    const layer = twoRegions("rgba8");
    await click(layer, 1, 1, { r: 1, g: 1, b: 1, a: 1 }, { selection: sel });
    expect(Math.abs(px(layer, 1, 1)[0] - Math.round(20 + (255 - 20) * (128 / 255)))).toBeLessThanOrEqual(1);
  });

  it("rgba32f: blends by a soft selection without rounding", async () => {
    const sel = new Uint8Array(W * H).fill(64);
    const layer = twoRegions("rgba32f");
    await click(layer, 1, 1, { r: 3, g: 3, b: 3, a: 1 }, { selection: sel });
    const w = 64 / 255;
    expect(px(layer, 1, 1)[0]).toBeCloseTo(0.1 + (srgbToLinearChannel(3) - 0.1) * w, 5);
    expect(px(layer, 1, 1)[3]).toBeCloseTo(1, 6);
  });

  it("soft selection over transparency adds coverage, not darkened colour", async () => {
    const sel = new Uint8Array(W * H).fill(128);
    const layer = makeLayer("rgba8", W, H);
    await click(layer, 1, 1, { r: 1, g: 1, b: 1, a: 1 }, { selection: sel });
    expect(px(layer, 1, 1)).toEqual([255, 255, 255, 128]);
  });

  it("indexed8 thresholds a soft selection at 50%", async () => {
    const sel = new Uint8Array(W * H);
    sel.fill(127, 0, W);
    sel.fill(128, W, 2 * W);
    const layer = twoRegions("indexed8");
    const swatches = [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }, { r: 255, g: 0, b: 0, a: 255 }];
    await click(layer, 1, 1, RED, { selection: sel, swatches });
    expect(layer.data[0]).toBe(0);
    expect(layer.data[W]).toBe(2);
  });
});
