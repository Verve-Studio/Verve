import { describe, expect, it } from "vitest";
import { clearSelectedPixels } from "@/utils/clearSelectedPixels";
import { makeLayer, px } from "@tests/fakes/toolsPixelFakes";

describe("clearSelectedPixels", () => {
  it("rgba8: a soft selection lowers alpha only; a full one clears the pixel", () => {
    const layer = makeLayer("rgba8", 3, 1, { fill: [200, 100, 50, 255] });
    clearSelectedPixels(layer, new Uint8Array([0, 128, 255]), 3);
    expect(px(layer, 0, 0)).toEqual([200, 100, 50, 255]);
    expect(px(layer, 1, 0)).toEqual([200, 100, 50, 127]);
    expect(px(layer, 2, 0)).toEqual([0, 0, 0, 0]);
  });

  it("rgba32f: unrounded alpha, colour (incl. HDR) untouched", () => {
    const layer = makeLayer("rgba32f", 2, 1, { fill: [3, 0.5, 0.25, 1] });
    clearSelectedPixels(layer, new Uint8Array([64, 0]), 2);
    const [r, g, b, a] = px(layer, 0, 0);
    expect([r, g, b]).toEqual([3, 0.5, 0.25]);
    expect(a).toBeCloseTo(1 - 64 / 255, 6);
    expect(px(layer, 1, 0)[3]).toBe(1);
  });

  it("indexed8: thresholds a soft selection at 50%", () => {
    const layer = makeLayer("indexed8", 3, 1, { fill: [4] });
    clearSelectedPixels(layer, new Uint8Array([1, 127, 128]), 3);
    expect(Array.from(layer.data)).toEqual([4, 4, 255]);
  });

  it("works in canvas space relative to the layer offset", () => {
    const layer = makeLayer("rgba8", 1, 1, { fill: [9, 9, 9, 255], offsetX: 1, offsetY: 1 });
    const mask = new Uint8Array(4);
    mask[3] = 255; // canvas (1, 1)
    clearSelectedPixels(layer, mask, 2);
    expect(px(layer, 0, 0)[3]).toBe(0);
  });
});
