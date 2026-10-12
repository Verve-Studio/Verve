import { describe, expect, it } from "vitest";
import type { RGBAColor } from "@/types";
import {
  expandIndicesToRgba,
  resolveNearestPaletteIndex,
  stampIndexedShape,
  writeIndexToLayer,
} from "@/utils/indexedColorUtils";
import { convertIndexedToRgba8 } from "@/utils/pixelFormatConvert";
import { makeLayer } from "@tests/fakes/toolsPixelFakes";

const PAL: RGBAColor[] = [
  { r: 0, g: 0, b: 0, a: 255 },
  { r: 255, g: 255, b: 255, a: 255 },
  { r: 255, g: 0, b: 0, a: 255 },
  { r: 255, g: 0, b: 0, a: 255 }, // duplicate of 2
];

/** Indices of a layer as a string grid ('.' = 255 sentinel). */
function grid(layer: ReturnType<typeof makeLayer>): string[] {
  const rows: string[] = [];
  for (let y = 0; y < layer.layerHeight; y++) {
    let s = "";
    for (let x = 0; x < layer.layerWidth; x++) {
      const v = layer.data[y * layer.layerWidth + x];
      s += v === 255 ? "." : String(v);
    }
    rows.push(s);
  }
  return rows;
}

describe("resolveNearestPaletteIndex", () => {
  it("returns 255 for an empty palette", () => {
    expect(resolveNearestPaletteIndex(1, 2, 3, 255, [])).toBe(255);
  });

  it("picks the nearest RGBA entry; ties go to the lower index", () => {
    expect(resolveNearestPaletteIndex(10, 10, 10, 255, PAL)).toBe(0);
    expect(resolveNearestPaletteIndex(250, 240, 240, 255, PAL)).toBe(1);
    expect(resolveNearestPaletteIndex(200, 20, 0, 255, PAL)).toBe(2);
  });

  it("considers alpha", () => {
    const pal = [
      { r: 255, g: 0, b: 0, a: 0 },
      { r: 200, g: 0, b: 0, a: 255 },
    ];
    expect(resolveNearestPaletteIndex(255, 0, 0, 255, pal)).toBe(1);
    expect(resolveNearestPaletteIndex(255, 0, 0, 0, pal)).toBe(0);
  });
});

describe("writeIndexToLayer", () => {
  it("writes in canvas space relative to the layer offset", () => {
    const layer = makeLayer("indexed8", 3, 2, { offsetX: 2, offsetY: 1 });
    expect(writeIndexToLayer(layer, 3, 2, 7)).toBe(true);
    expect(grid(layer)).toEqual(["...", ".7."]);
    expect(writeIndexToLayer(layer, 0, 0, 7)).toBe(false);
    expect(writeIndexToLayer(layer, 5, 1, 7)).toBe(false);
  });

  it("is gated by the selection mask and its bounds", () => {
    const layer = makeLayer("indexed8", 4, 1);
    const sel = { mask: new Uint8Array([0, 128, 255, 0]), width: 2 };
    expect(writeIndexToLayer(layer, 0, 0, 1, sel)).toBe(false);
    expect(writeIndexToLayer(layer, 1, 0, 1, sel)).toBe(true);
    // x past the selection width must not read into the next row.
    expect(writeIndexToLayer(layer, 2, 0, 1, sel)).toBe(false);
    expect(grid(layer)).toEqual([".1.."]);
  });

  it("thresholds a soft selection at 50% (no partial alpha in indexed8)", () => {
    const layer = makeLayer("indexed8", 3, 1);
    const sel = { mask: new Uint8Array([1, 127, 128]), width: 3 };
    expect(writeIndexToLayer(layer, 0, 0, 1, sel)).toBe(false);
    expect(writeIndexToLayer(layer, 1, 0, 1, sel)).toBe(false);
    expect(writeIndexToLayer(layer, 2, 0, 1, sel)).toBe(true);
    expect(grid(layer)).toEqual(["..1"]);
  });

  it("wraps in tiled mode", () => {
    const layer = makeLayer("indexed8", 4, 4);
    expect(writeIndexToLayer(layer, -1, 5, 3, undefined, 4, 4)).toBe(true);
    expect(layer.data[1 * 4 + 3]).toBe(3);
  });
});

describe("stampIndexedShape", () => {
  it.each([
    ["square", 3, ["......", ".333..", ".333..", ".333..", "......"]],
    ["round", 3, ["......", "..3...", ".333..", "..3...", "......"]],
    ["diamond", 3, ["......", "..3...", ".333..", "..3...", "......"]],
    ["round", 2, ["......", ".33...", ".33...", "......", "......"]],
    ["square", 1, ["......", "......", "..3...", "......", "......"]],
  ] as const)("%s size %i", (shape, size, expected) => {
    const layer = makeLayer("indexed8", 6, 5);
    stampIndexedShape(layer, 2, 2, 3, size, shape);
    expect(grid(layer)).toEqual(expected);
  });

  it("round size 4 covers 12 pixels (pencil footprint rule)", () => {
    const layer = makeLayer("indexed8", 8, 8);
    stampIndexedShape(layer, 4, 4, 1, 4, "round");
    expect(Array.from(layer.data).filter((v) => v === 1)).toHaveLength(12);
  });

  it("clips at layer edges without wrapping rows", () => {
    const layer = makeLayer("indexed8", 4, 3);
    stampIndexedShape(layer, 0, 1, 2, 3, "square");
    expect(grid(layer)).toEqual(["22..", "22..", "22.."]);
  });
});

describe("expandIndicesToRgba", () => {
  it("matches convertIndexedToRgba8 and maps the sentinel to transparent", () => {
    const idx = new Uint8Array([0, 1, 2, 3, 255, 4, 200]);
    const out = expandIndicesToRgba(idx, PAL);
    expect(Array.from(out)).toEqual(Array.from(convertIndexedToRgba8(idx, PAL)));
    expect(Array.from(out.subarray(16, 28))).toEqual(new Array(12).fill(0));
  });
});
