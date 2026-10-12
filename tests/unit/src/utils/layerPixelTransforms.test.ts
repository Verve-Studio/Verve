import { beforeAll, describe, expect, it } from "vitest";
import { getPixelOps } from "@/wasm";
import type { PixelFormat } from "@/types";
import { clipLayerToCanvas, resampleLayer, toCanvasSized, type LayerBuffer } from "@/utils/layerPixelTransforms";

beforeAll(async () => {
  await getPixelOps();
});

/** A layer whose every channel encodes its (x, y): value = 1 + x + 10·y. */
function coded(format: PixelFormat, w: number, h: number, offsetX = 0, offsetY = 0): LayerBuffer {
  const ch = format === "indexed8" ? 1 : 4;
  const data = format === "rgba32f" ? new Float32Array(w * h * ch) : new Uint8Array(w * h * ch);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < ch; c++) data[(y * w + x) * ch + c] = 1 + x + 10 * y;
  return { data, format, width: w, height: h, offsetX, offsetY };
}

const at = (b: LayerBuffer, x: number, y: number): number =>
  b.data[(y * b.width + x) * (b.format === "indexed8" ? 1 : 4)];

describe.each(["rgba8", "rgba32f", "indexed8"] as PixelFormat[])("clipLayerToCanvas (%s)", (format) => {
  it("keeps format and buffer type", () => {
    const out = clipLayerToCanvas(coded(format, 4, 4), 0, 0, 10, 10);
    expect(out.format).toBe(format);
    expect(out.data).toBeInstanceOf(format === "rgba32f" ? Float32Array : Uint8Array);
    expect(out.data.length).toBe(16 * (format === "indexed8" ? 1 : 4));
  });

  it("crops a move by (-x, -y) onto a smaller canvas", () => {
    const src = coded(format, 5, 4, 1, 1);
    // Crop rect (2, 2, 3×2) on the canvas.
    const out = clipLayerToCanvas(src, -2, -2, 3, 2);
    expect(out).toMatchObject({ width: 3, height: 2, offsetX: 0, offsetY: 0 });
    // Canvas (2,2) is layer-local (1,1).
    expect(at(out, 0, 0)).toBe(1 + 1 + 10);
    expect(at(out, 2, 1)).toBe(1 + 3 + 20);
  });

  it("keeps the offset when the layer sits inside the canvas", () => {
    const out = clipLayerToCanvas(coded(format, 2, 2), 3, 4, 10, 10);
    expect(out).toMatchObject({ width: 2, height: 2, offsetX: 3, offsetY: 4 });
    expect(at(out, 1, 1)).toBe(12);
  });

  it("returns a 1×1 transparent layer when fully outside", () => {
    const out = clipLayerToCanvas(coded(format, 2, 2), 50, 0, 10, 10);
    expect(out).toMatchObject({ width: 1, height: 1, offsetX: 0, offsetY: 0, format });
    if (format === "indexed8") expect(Array.from(out.data)).toEqual([255]);
    else expect(Array.from(out.data)).toEqual([0, 0, 0, 0]);
  });
});

describe("resampleLayer", () => {
  it("2× nearest upscale duplicates pixels (rgba8)", async () => {
    const src = coded("rgba8", 2, 2);
    const out = await resampleLayer(src, 2, 2, 4, 4, "nearest");
    expect(out).toMatchObject({ width: 4, height: 4, offsetX: 0, offsetY: 0, format: "rgba8" });
    expect(at(out, 0, 0)).toBe(1);
    expect(at(out, 1, 1)).toBe(1);
    expect(at(out, 2, 0)).toBe(2);
    expect(at(out, 3, 3)).toBe(12);
  });

  it("indexed8 always copies indices (no interpolation), even when bilinear is asked", async () => {
    const src: LayerBuffer = {
      data: new Uint8Array([3, 7, 255, 1]),
      format: "indexed8",
      width: 2,
      height: 2,
      offsetX: 0,
      offsetY: 0,
    };
    const out = await resampleLayer(src, 2, 2, 5, 5, "bilinear");
    expect(out.data).toBeInstanceOf(Uint8Array);
    expect(out.data.length).toBe(25);
    for (const v of out.data) expect([3, 7, 255, 1]).toContain(v);
    expect(new Set(out.data).size).toBe(4);
  });

  it("rgba32f keeps HDR values > 1 unclamped", async () => {
    const data = new Float32Array(2 * 2 * 4);
    for (let i = 0; i < 4; i++) data.set([8, 2.5, 0.25, 1], i * 4);
    const src: LayerBuffer = { data, format: "rgba32f", width: 2, height: 2, offsetX: 0, offsetY: 0 };
    const out = await resampleLayer(src, 2, 2, 3, 3, "bilinear");
    expect(out.data).toBeInstanceOf(Float32Array);
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBeCloseTo(8, 4);
      expect(out.data[i + 1]).toBeCloseTo(2.5, 4);
      expect(out.data[i + 2]).toBeCloseTo(0.25, 4);
      expect(out.data[i + 3]).toBeCloseTo(1, 4);
    }
  });

  it("bilinear downscale of a constant layer stays constant", async () => {
    const data = new Uint8Array(8 * 8 * 4).fill(200);
    const src: LayerBuffer = { data, format: "rgba8", width: 8, height: 8, offsetX: 0, offsetY: 0 };
    const out = await resampleLayer(src, 8, 8, 3, 3, "bilinear");
    expect(out).toMatchObject({ width: 3, height: 3 });
    for (const v of out.data) expect(v).toBe(200);
  });

  it("scales the layer's offset with the canvas", async () => {
    const src = coded("rgba8", 2, 2, 4, 6);
    const out = await resampleLayer(src, 10, 10, 20, 20, "nearest");
    expect(out).toMatchObject({ offsetX: 8, offsetY: 12, width: 4, height: 4 });
  });

  it("returns an empty layer when the scaled footprint is off-canvas", async () => {
    const src = coded("rgba8", 2, 2, 12, 0);
    const out = await resampleLayer(src, 10, 10, 5, 5, "nearest");
    expect(out).toMatchObject({ width: 1, height: 1 });
  });
});

describe("toCanvasSized", () => {
  it("places an rgba8 layer at its offset in a transparent canvas buffer, clipped", () => {
    const src = coded("rgba8", 3, 2, 2, 1);
    const out = toCanvasSized(src, 4, 3);
    expect(out.length).toBe(4 * 3 * 4);
    const pix = (x: number, y: number): number => out[(y * 4 + x) * 4];
    expect(pix(0, 0)).toBe(0);
    expect(pix(2, 1)).toBe(1);
    expect(pix(3, 2)).toBe(12);
    expect(pix(1, 2)).toBe(0);
  });
});
