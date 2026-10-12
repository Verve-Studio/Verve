// CPU flatten used for cell-animation previews (flattenDecodedDocument).
import { describe, expect, it } from "vitest";
import type { LayerState } from "@/types";
import { createLayerDataBundle, type LayerPayload } from "@/core/store/layerPayload";
import type { DecodedDocument } from "@/core/io/documentDecode";
import { compositeToRgba8, flattenDecodedDocument } from "@/core/io/cellPreview";

const base = { visible: true, opacity: 1, locked: false, blendMode: "normal" as const };

function doc(
  w: number,
  h: number,
  layers: LayerState[],
  pixels: Record<string, LayerPayload>,
  swatches?: DecodedDocument["swatches"],
): DecodedDocument {
  const layerData = createLayerDataBundle();
  for (const [id, p] of Object.entries(pixels)) layerData.layers.set(id, p);
  return { width: w, height: h, pixelFormat: "rgba8", backgroundFill: "transparent", layers, activeLayerId: null, layerData, swatches };
}

const solid8 = (w: number, h: number, c: number[]): Uint8Array => {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set(c, i * 4);
  return out;
};

describe("flattenDecodedDocument", () => {
  it("returns an opaque rgba8 layer unchanged (sRGB ↔ linear round trip is exact)", () => {
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) data.set([i, 255 - i, (i * 3) & 255, 255], i * 4);
    const out = flattenDecodedDocument(doc(256, 1, [{ id: "a", name: "A", ...base }], { a: { format: "rgba8", data } }));
    expect(out).toEqual(data);
  });

  it("stacks bottom-first: opaque upper pixels win, transparent ones show through", () => {
    const top = new Uint8Array([0, 0, 255, 255, 0, 0, 0, 0]);
    const out = flattenDecodedDocument(
      doc(2, 1, [{ id: "bottom", name: "B", ...base }, { id: "top", name: "T", ...base }], {
        bottom: { format: "rgba8", data: solid8(2, 1, [255, 0, 0, 255]) },
        top: { format: "rgba8", data: top },
      }),
    );
    expect(Array.from(out)).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
  });

  it("skips hidden layers, mask and adjustment layers; honours layer offsets", () => {
    const layers: LayerState[] = [
      { id: "a", name: "A", ...base },
      { id: "hidden", name: "H", ...base, visible: false },
      { id: "adj", name: "Adj", visible: true, type: "adjustment", parentId: "a", effectType: "invert", params: {}, hasMask: false } as unknown as LayerState,
    ];
    const out = flattenDecodedDocument(
      doc(3, 1, layers, {
        a: { format: "rgba8", data: new Uint8Array([10, 20, 30, 255]), geo: { layerWidth: 1, layerHeight: 1, offsetX: 2, offsetY: 0 } },
        hidden: { format: "rgba8", data: solid8(3, 1, [255, 255, 255, 255]) },
      }),
    );
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 10, 20, 30, 255]);
  });

  it("applies a layer mask (black hides, white reveals)", () => {
    const layers: LayerState[] = [
      { id: "a", name: "A", ...base },
      { id: "m", name: "Mask", visible: true, type: "mask", parentId: "a" },
    ];
    const out = flattenDecodedDocument(
      doc(2, 1, layers, {
        a: { format: "rgba8", data: solid8(2, 1, [200, 100, 50, 255]) },
        m: { format: "rgba8", data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]) },
      }),
    );
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 200, 100, 50, 255]);
  });

  it("walks group children and drops hidden groups", () => {
    const layers: LayerState[] = [
      { id: "child", name: "C", ...base },
      { id: "g", name: "G", ...base, type: "group", collapsed: false, childIds: ["child"] },
      { id: "hiddenChild", name: "HC", ...base },
      { id: "hg", name: "HG", ...base, visible: false, type: "group", collapsed: false, childIds: ["hiddenChild"] },
    ];
    const out = flattenDecodedDocument(
      doc(1, 1, layers, {
        child: { format: "rgba8", data: new Uint8Array([1, 2, 3, 255]) },
        hiddenChild: { format: "rgba8", data: new Uint8Array([9, 9, 9, 255]) },
      }),
    );
    expect(Array.from(out)).toEqual([1, 2, 3, 255]);
  });

  it("encodes rgba32f layers to sRGB (HDR clamps) and expands indexed8 via the palette", () => {
    const out = flattenDecodedDocument(
      doc(
        3,
        1,
        [{ id: "f", name: "F", ...base }, { id: "i", name: "I", ...base }],
        {
          f: { format: "rgba32f", data: new Float32Array([0.5, 4, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]) },
          i: { format: "indexed8", data: new Uint8Array([255, 1, 7]) }, // 7: no palette entry
        },
        [
          { r: 0, g: 0, b: 0, a: 255 },
          { r: 12, g: 34, b: 56, a: 255 },
        ],
      ),
    );
    expect(Array.from(out)).toEqual([188, 255, 0, 255, 12, 34, 56, 255, 0, 0, 0, 0]);
  });

  it("layer opacity blends in linear light", () => {
    const out = flattenDecodedDocument(
      doc(1, 1, [{ id: "a", name: "A", ...base, opacity: 0.5 }], { a: { format: "rgba8", data: new Uint8Array([255, 255, 255, 255]) } }),
    );
    // Colour stays white; coverage is half.
    expect(Array.from(out)).toEqual([255, 255, 255, 128]);
  });
});

describe("compositeToRgba8", () => {
  it("passes bytes through and sRGB-encodes floats", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(compositeToRgba8(bytes)).toBe(bytes);
    expect(Array.from(compositeToRgba8(new Float32Array([0.5, 0, 1, 1])))).toEqual([188, 0, 255, 255]);
  });
});
