// `.verve` save → open round trip: payload serialization (verveDocument.ts)
// through the container and back via decodeVerveDocument.
import { describe, expect, it } from "vitest";
import type { Brush, LayerState, PixelBrush } from "@/types";
import { makeDefaultBrush } from "@/core/tools/Brush/brushPreset";
import { decodeVerveDocument } from "@/core/io/documentDecode";
import { decodeVerveContainer } from "@/core/io/verveContainer";
import { readVervePayloads, VERVE_DOC_VERSION } from "@/core/io/verveDocument";
import { bytesToBase64 } from "@/utils/base64";
import { encodeFakeDocument, type FakeDocument } from "@tests/fakes/ioVerveDoc";

const W = 7;
const H = 5;

const base = { visible: true, opacity: 1, locked: false, blendMode: "normal" as const };

function rgba8(w: number, h: number, seed: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < out.length; i++) out[i] = (i * 31 + seed * 17) & 0xff;
  return out;
}

/** Scene-linear floats incl. HDR (> 1), zero and fractional alpha. */
function rgba32f(w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set([i * 0.37, 12.5, 1 / 3, (i % 3) / 2], i * 4);
  return out;
}

function fixture(): FakeDocument {
  const layers: LayerState[] = [
    { id: "bg", name: "Background", ...base },
    { id: "hdr", name: "HDR", ...base, opacity: 0.5, blendMode: "screen" },
    { id: "idx", name: "Indexed", ...base, visible: false },
    { id: "empty", name: "Transparent 1×1", ...base },
    { id: "grp", name: "Group", ...base, type: "group", collapsed: true, childIds: ["txt", "shp"] },
    {
      id: "txt",
      name: "Title",
      ...base,
      type: "text",
      text: "Hëllo\nWörld",
      x: 1,
      y: 2,
      boxWidth: 0,
      boxHeight: 0,
      fontFamily: "Inter",
      fontSize: 24,
      bold: true,
      italic: false,
      underline: false,
      strikethrough: true,
      align: "center",
      letterSpacing: 0.5,
      lineHeight: 1.2,
      kerning: "auto",
      color: { r: 2.5, g: 0.5, b: 0, a: 1 },
      strokeColor: null,
      ligatures: "all",
    },
    {
      id: "shp",
      name: "Shape",
      ...base,
      type: "shape",
      shapeType: "rectangle",
      cx: 3,
      cy: 2,
      w: 4,
      h: 2,
      rotation: 15,
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      strokeColor: { r: 0, g: 0, b: 0, a: 1 },
      fillColor: null,
      fillGradient: {
        type: "linear",
        startX: 0,
        startY: 0,
        endX: 1,
        endY: 1,
        stops: [
          { offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { offset: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
        ],
      },
      strokeWidth: 2,
      cornerRadius: 1,
      antiAlias: true,
    },
    {
      id: "frm",
      name: "Frame",
      ...base,
      type: "frame",
      frameType: "ellipse",
      cx: 3,
      cy: 3,
      w: 4,
      h: 4,
      rotation: 0,
      content: { rgba: rgba8(3, 2, 9), width: 3, height: 2 },
      fit: "fit",
      contentOffsetX: 1,
      contentOffsetY: -1,
      contentScale: 1.5,
      strokeColor: null,
      strokeWidth: 0,
    },
    { id: "msk", name: "Mask", visible: true, type: "mask", parentId: "bg" },
    {
      id: "adj",
      name: "Brightness",
      visible: true,
      type: "adjustment",
      parentId: "bg",
      effectType: "brightness-contrast",
      params: { brightness: 12, contrast: -7 },
      hasMask: true,
    } as unknown as LayerState,
  ];
  const pixels = new Map<string, FakeDocument["pixels"] extends Map<string, infer V> ? V : never>([
    ["bg", { format: "rgba8", data: rgba8(W, H, 1), geo: { layerWidth: W, layerHeight: H, offsetX: 0, offsetY: 0 } }],
    ["hdr", { format: "rgba32f", data: rgba32f(3, 3), geo: { layerWidth: 3, layerHeight: 3, offsetX: -2, offsetY: 4 } }],
    ["idx", { format: "indexed8", data: Uint8Array.from({ length: 5 * 2 }, (_, i) => (i === 3 ? 255 : i)), geo: { layerWidth: 5, layerHeight: 2, offsetX: 1, offsetY: 1 } }],
    ["empty", { format: "rgba8", data: new Uint8Array(4), geo: { layerWidth: 1, layerHeight: 1, offsetX: 6, offsetY: 4 } }],
    ["txt", { format: "rgba8", data: rgba8(2, 2, 3), geo: { layerWidth: 2, layerHeight: 2, offsetX: 0, offsetY: 0 } }],
    ["msk", { format: "rgba8", data: rgba8(W, H, 4), geo: { layerWidth: W, layerHeight: H, offsetX: 0, offsetY: 0 } }],
  ]);
  const adjMask = new Uint8Array(W * H * 4).fill(128);
  const pixelBrush: PixelBrush = { id: "pb1", name: "Dot", width: 2, height: 1, rgba: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), createdAt: 1700000000000 };
  const bitmapBrush: Brush = {
    ...makeDefaultBrush("b2", "Sampled"),
    shape: { kind: "bitmap", bitmapRgba: rgba8(2, 2, 5), bitmapWidth: 2, bitmapHeight: 2 },
  };
  return {
    pixelFormat: "rgba32f",
    width: W,
    height: H,
    backgroundFill: "white",
    activeLayerId: "hdr",
    layers,
    pixels,
    adjustmentMasks: new Map([["adj", adjMask]]),
    swatches: [
      { r: 0, g: 0, b: 0, a: 255 },
      { r: 255, g: 128, b: 1, a: 200 },
    ],
    swatchGroups: [{ id: "g1", name: "Warm", swatchIndices: [1] }],
    pixelBrushes: [pixelBrush],
    brushes: [makeDefaultBrush("b1"), bitmapBrush],
    activeBrushId: "b2",
    spritesheet: { enabled: true, cellWidth: 16, cellHeight: 16, onionSkin: false, onionFrames: 1 } as FakeDocument["spritesheet"],
    iccProfile: new Uint8Array([0, 0, 2, 0, 0x61, 0x63, 0x73, 0x70]),
  };
}

describe("verve document round trip", () => {
  it("restores layers, pixels in their native format, masks, brushes and metadata", async () => {
    const src = fixture();
    const bytes = await encodeFakeDocument(src);
    const doc = await decodeVerveDocument(bytes, "C:\\docs\\art.verve");

    expect(doc.width).toBe(W);
    expect(doc.height).toBe(H);
    expect(doc.pixelFormat).toBe("rgba32f");
    expect(doc.backgroundFill).toBe("white");
    expect(doc.activeLayerId).toBe("hdr");
    expect(doc.swatches).toEqual(src.swatches);
    expect(doc.swatchGroups).toEqual(src.swatchGroups);
    expect(doc.activeBrushId).toBe("b2");
    expect(doc.spritesheet).toEqual(src.spritesheet);
    expect(doc.iccProfile).toEqual(src.iccProfile);

    // Layer state: same order, ids and parametric fields; pixel payload
    // fields are stripped; frame content comes back as bytes.
    expect(doc.layers.map((l) => l.id)).toEqual(src.layers.map((l) => l.id));
    for (const l of doc.layers) {
      expect(l).not.toHaveProperty("pixels");
      expect(l).not.toHaveProperty("adjustmentMask");
    }
    const byId = new Map(doc.layers.map((l) => [l.id, l]));
    for (const id of ["bg", "hdr", "idx", "grp", "txt", "shp", "msk", "adj"]) {
      expect(byId.get(id)).toEqual(src.layers.find((l) => l.id === id));
    }
    const frame = byId.get("frm") as Extract<LayerState, { type: "frame" }>;
    const srcFrame = src.layers.find((l) => l.id === "frm") as Extract<LayerState, { type: "frame" }>;
    expect(frame).toEqual({ ...srcFrame, content: { ...srcFrame.content!, rgba: expect.any(Uint8Array) } });
    expect(Array.from(frame.content!.rgba)).toEqual(Array.from(srcFrame.content!.rgba));

    // Pixels: bit-exact, native typed array, same geometry.
    for (const [id, p] of src.pixels) {
      const got = doc.layerData.layers.get(id);
      expect(got, id).toBeDefined();
      expect(got!.format).toBe(p.format);
      expect(got!.geo).toEqual(p.geo);
      if (p.format === "rgba32f") {
        expect(got!.data).toBeInstanceOf(Float32Array);
        expect(Array.from(got!.data)).toEqual(Array.from(p.data));
      } else {
        expect(got!.data).toBeInstanceOf(Uint8Array);
        expect(got!.data).toEqual(p.data);
      }
    }
    // Layers without pixels have no payload.
    expect(doc.layerData.layers.has("grp")).toBe(false);
    expect(doc.layerData.layers.has("adj")).toBe(false);
    expect(doc.layerData.adjustmentMasks.get("adj")).toEqual(src.adjustmentMasks!.get("adj"));

    // Brushes.
    expect(doc.pixelBrushes).toEqual(src.pixelBrushes);
    expect(doc.brushes).toHaveLength(2);
    expect(doc.brushes![0]).toEqual(src.brushes![0]);
    expect(doc.brushes![1].shape.kind).toBe("bitmap");
    expect(doc.brushes![1].shape.bitmapRgba).toEqual(src.brushes![1].shape.bitmapRgba);
  });

  it("stores every payload as a blob reference, never base64", async () => {
    const bytes = await encodeFakeDocument(fixture());
    const { doc } = decodeVerveContainer<{ version: number; layers: Array<Record<string, unknown>>; iccProfile: string }>(bytes);
    expect(doc.version).toBe(VERVE_DOC_VERSION);
    const header = JSON.stringify(doc);
    // A 7×5 rgba8 layer alone would be ~190 base64 chars; nothing that long.
    expect(header).not.toMatch(/data:image|[A-Za-z0-9+/]{40,}={0,2}/);
    const bg = doc.layers.find((l) => l.id === "bg") as { pixels: { data: string } };
    expect(bg.pixels.data).toMatch(/^blob:\d+$/);
    expect(doc.iccProfile).toMatch(/^blob:\d+$/);
  });

  it("round-trips a 1×1 fully transparent rgba8 document", async () => {
    const bytes = await encodeFakeDocument({
      pixelFormat: "rgba8",
      width: 1,
      height: 1,
      activeLayerId: "a",
      layers: [{ id: "a", name: "A", ...base }],
      pixels: new Map([["a", { format: "rgba8", data: new Uint8Array(4), geo: { layerWidth: 1, layerHeight: 1, offsetX: 0, offsetY: 0 } }]]),
      swatches: [],
      swatchGroups: [],
    });
    const doc = await decodeVerveDocument(bytes, "/tmp/a.verve");
    expect(doc.pixelFormat).toBe("rgba8");
    expect(Array.from(doc.layerData.layers.get("a")!.data)).toEqual([0, 0, 0, 0]);
    expect(doc.iccProfile).toBeUndefined();
    expect(doc.pixelBrushes).toEqual([]);
    expect(doc.brushes).toEqual([]);
  });

  it("round-trips a larger rgba32f layer bit-exactly (incl. NaN-free extremes)", async () => {
    const w = 257;
    const h = 129;
    const data = new Float32Array(w * h * 4);
    for (let i = 0; i < data.length; i++) data[i] = Math.fround(Math.sin(i) * 1000);
    data[0] = 3.4028234663852886e38;
    data[1] = -0;
    data[2] = 1.401298464324817e-45;
    const bytes = await encodeFakeDocument({
      pixelFormat: "rgba32f",
      width: w,
      height: h,
      activeLayerId: "a",
      layers: [{ id: "a", name: "A", ...base }],
      pixels: new Map([["a", { format: "rgba32f", data, geo: { layerWidth: w, layerHeight: h, offsetX: 0, offsetY: 0 } }]]),
      swatches: [],
      swatchGroups: [],
    });
    const got = (await decodeVerveDocument(bytes, "a.verve")).layerData.layers.get("a")!.data as Float32Array;
    expect(got.length).toBe(data.length);
    expect(Buffer.from(got.buffer, got.byteOffset, got.byteLength).equals(Buffer.from(data.buffer))).toBe(true);
  });
});

describe("readVervePayloads (legacy base64 payloads, version ≤ 6)", () => {
  it("decodes base64 float / indexed pixels, ICC profile and pixel brushes without a container", async () => {
    const f32 = new Float32Array([1.5, 0, 0.25, 1]);
    const idx = new Uint8Array([0, 1, 255, 2]);
    const icc = new Uint8Array([1, 2, 3]);
    const result = await readVervePayloads(
      {
        layers: [
          { id: "f", name: "F", ...base, layerDataF32: bytesToBase64(new Uint8Array(f32.buffer)), layerGeo: { layerWidth: 1, layerHeight: 1, offsetX: 0, offsetY: 0 } },
          { id: "i", name: "I", ...base, layerDataIndexed: bytesToBase64(idx) },
          { id: "n", name: "No pixels", ...base },
        ],
        pixelBrushes: [
          { id: "p", name: "P", width: 1, height: 1, rgba: bytesToBase64(new Uint8Array([9, 9, 9, 9])), createdAt: 0 },
          { id: "bad", name: "Wrong size", width: 2, height: 2, rgba: bytesToBase64(new Uint8Array(4)), createdAt: 0 },
          { id: "nostr", name: "No data", width: 1, height: 1, createdAt: 0 },
        ],
        iccProfileBase64: bytesToBase64(icc),
      },
      null,
      1,
      1,
    );
    expect(result.layers.map((l) => l.id)).toEqual(["f", "i", "n"]);
    for (const l of result.layers) {
      expect(l).not.toHaveProperty("layerDataF32");
      expect(l).not.toHaveProperty("layerDataIndexed");
      expect(l).not.toHaveProperty("layerGeo");
    }
    const f = result.data.layers.get("f")!;
    expect(f.format).toBe("rgba32f");
    expect(Array.from(f.data)).toEqual([1.5, 0, 0.25, 1]);
    expect(f.geo).toEqual({ layerWidth: 1, layerHeight: 1, offsetX: 0, offsetY: 0 });
    const i = result.data.layers.get("i")!;
    expect(i.format).toBe("indexed8");
    expect(i.data).toEqual(idx);
    expect(i.geo).toBeUndefined();
    expect(result.data.layers.has("n")).toBe(false);
    expect(result.iccProfile).toEqual(icc);
    // Invalid brushes are dropped, valid ones kept.
    expect(result.pixelBrushes.map((b) => b.id)).toEqual(["p"]);
    expect(result.brushes).toEqual([]);
  });

  it("drops a brush tip whose blob is missing (falls back to no bitmap) instead of failing", async () => {
    const result = await readVervePayloads(
      {
        layers: [],
        brushes: [{ ...makeDefaultBrush("x"), shape: { kind: "bitmap", bitmapRgba: "blob:7", bitmapWidth: 1, bitmapHeight: 1 } }],
      },
      async () => {
        throw new Error("missing");
      },
      1,
      1,
    );
    expect(result.brushes).toHaveLength(1);
    expect(result.brushes[0].shape.bitmapRgba).toBeUndefined();
  });

  it("propagates a missing layer-pixel blob as an error", async () => {
    await expect(
      readVervePayloads(
        {
          layers: [
            { id: "a", name: "A", ...base, pixels: { format: "rgba8", data: "blob:3", geo: { layerWidth: 1, layerHeight: 1, offsetX: 0, offsetY: 0 } } },
          ],
        },
        async (ref) => {
          throw new Error(`The document references a missing blob (${ref}).`);
        },
        1,
        1,
      ),
    ).rejects.toThrow(/missing blob/);
  });
});
