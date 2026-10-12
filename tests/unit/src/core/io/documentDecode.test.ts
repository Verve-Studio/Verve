// documentDecode: validation, legacy migration, linked-layer paths and
// multi-layer EXR documents.
import { describe, expect, it } from "vitest";
import type { LayerState, LinkedLayerState } from "@/types";
import { encodeExr, encodeExrLayers } from "@/wasm";
import { DEFAULT_SWATCHES } from "@/core/store/tabTypes";
import { decodeExrDocument, decodeVerveDocument, directoryOf } from "@/core/io/documentDecode";
import { encodeFakeDocument } from "@tests/fakes/ioVerveDoc";

const base = { visible: true, opacity: 1, locked: false, blendMode: "normal" as const };
const json = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));

function legacyDoc(over: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 6,
    pixelFormat: "rgba8",
    canvas: { width: 2, height: 2 },
    activeLayerId: null,
    layers: [],
    swatches: [{ r: 1, g: 2, b: 3, a: 255 }],
    swatchGroups: [],
    ...over,
  };
}

function linked(id: string, abs: string, rel: string | null): LinkedLayerState {
  return {
    id,
    name: id,
    ...base,
    type: "linked",
    source: { absolutePath: abs, relativePath: rel, sourceWidth: 4, sourceHeight: 4 },
    centerX: 0,
    centerY: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    refreshNonce: 0,
  };
}

describe("directoryOf", () => {
  it("strips the file name for POSIX and Windows paths", () => {
    expect(directoryOf("/home/u/a.verve")).toBe("/home/u");
    expect(directoryOf("C:\\Users\\u\\a.verve")).toBe("C:\\Users\\u");
    expect(directoryOf("a.verve")).toBe("");
  });
});

describe("decodeVerveDocument validation", () => {
  it("rejects an unsupported pixel format", async () => {
    await expect(decodeVerveDocument(json(legacyDoc({ pixelFormat: "rgba16" })), "a.verve")).rejects.toThrow(
      /unsupported pixel format/,
    );
  });

  it("rejects invalid swatches and swatch groups", async () => {
    await expect(
      decodeVerveDocument(json(legacyDoc({ swatches: [{ r: 256, g: 0, b: 0, a: 255 }] })), "a.verve"),
    ).rejects.toThrow(/invalid swatch data/);
    await expect(
      decodeVerveDocument(json(legacyDoc({ swatches: [{ r: 1.5, g: 0, b: 0, a: 255 }] })), "a.verve"),
    ).rejects.toThrow(/invalid swatch data/);
    await expect(
      decodeVerveDocument(
        json(legacyDoc({ swatchGroups: [{ id: "g", name: "G", swatchIndices: [1] }] })),
        "a.verve",
      ),
    ).rejects.toThrow(/invalid swatch group data/);
    await expect(
      decodeVerveDocument(
        json(
          legacyDoc({
            swatchGroups: [
              { id: "a", name: "Same", swatchIndices: [] },
              { id: "b", name: "Same", swatchIndices: [] },
            ],
          }),
        ),
        "a.verve",
      ),
    ).rejects.toThrow(/invalid swatch group data/);
  });

  it("rejects files that are neither a container nor JSON", async () => {
    await expect(decodeVerveDocument(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "a.verve")).rejects.toThrow();
  });

  it("applies version gates: v1 gets default swatches and rgba8; brushes need v4", async () => {
    const doc = await decodeVerveDocument(
      json({
        version: 1,
        pixelFormat: "rgba32f", // ignored before v5
        canvas: { width: 3, height: 2 },
        activeLayerId: null,
        layers: [{ id: "a", name: "A", ...base }],
        pixelBrushes: [{ id: "p", name: "P", width: 1, height: 1, rgba: "AQIDBA==", createdAt: 0 }],
        spritesheet: { enabled: true },
      }),
      "a.verve",
    );
    expect(doc.pixelFormat).toBe("rgba8");
    expect(doc.swatches).toBe(DEFAULT_SWATCHES);
    expect(doc.swatchGroups).toEqual([]);
    expect(doc.pixelBrushes).toEqual([]);
    expect(doc.spritesheet).toBeUndefined();
    expect(doc.backgroundFill).toBe("transparent");
    // activeLayerId falls back to the first layer.
    expect(doc.activeLayerId).toBe("a");
  });

  it("migrates legacy `adjustmentType` to `effectType`", async () => {
    const doc = await decodeVerveDocument(
      json(
        legacyDoc({
          layers: [
            { id: "x", name: "X", visible: true, type: "adjustment", parentId: "p", adjustmentType: "invert", params: {}, hasMask: false },
            { id: "y", name: "Y", visible: true, type: "adjustment", parentId: "p", adjustmentType: "old", effectType: "new", params: {}, hasMask: false },
          ],
        }),
      ),
      "a.verve",
    );
    const [x, y] = doc.layers as unknown as Array<Record<string, unknown>>;
    expect(x.effectType).toBe("invert");
    expect(x).not.toHaveProperty("adjustmentType");
    expect(y.effectType).toBe("new");
    expect(y).not.toHaveProperty("adjustmentType");
  });
});

describe("linked layers", () => {
  it("re-resolves the absolute path from the relative path against the opened document", async () => {
    const layers: LayerState[] = [
      linked("posix", "/old/place/img.png", "assets/img.png"),
      linked("up", "/old/img.png", "../shared/./img.png"),
      linked("norel", "/abs/only.png", null),
    ];
    const bytes = await encodeFakeDocument({
      pixelFormat: "rgba8",
      width: 2,
      height: 2,
      activeLayerId: null,
      layers,
      pixels: new Map(),
      swatches: [],
      swatchGroups: [],
    });
    const doc = await decodeVerveDocument(bytes, "/new/home/doc.verve");
    const src = (id: string) => (doc.layers.find((l) => l.id === id) as LinkedLayerState).source.absolutePath;
    expect(src("posix")).toBe("/new/home/assets/img.png");
    expect(src("up")).toBe("/new/shared/img.png");
    expect(src("norel")).toBe("/abs/only.png");

    const win = await decodeVerveDocument(bytes, "D:\\Work\\doc.verve");
    expect((win.layers.find((l) => l.id === "posix") as LinkedLayerState).source.absolutePath).toBe(
      "D:\\Work\\assets\\img.png",
    );
  });
});

describe("decodeExrDocument", () => {
  it("builds one rgba32f layer per EXR layer with unique names and exact pixels", async () => {
    const a = new Float32Array([1, 2, 3, 1, 0, 0, 0, 0]);
    const b = new Float32Array([0.5, 0.5, 0.5, 0.5, 8, 9, 10, 1]);
    const c = new Float32Array(8).fill(0.125);
    const bytes = await encodeExrLayers(
      [
        { name: "Paint", pixels: a },
        { name: "Paint", pixels: b },
        { name: "Paint", pixels: c },
      ],
      2,
      1,
    );
    const doc = await decodeExrDocument(bytes);
    expect([doc.width, doc.height, doc.pixelFormat]).toEqual([2, 1, "rgba32f"]);
    // The EXR writer itself makes channel-group names unique.
    expect(new Set(doc.layers.map((l) => l.name)).size).toBe(3);
    expect(doc.layers[0].name).toBe("Paint");
    expect(doc.layers.map((l) => l.id)).toEqual(["layer-0", "layer-1", "layer-2"]);
    expect(doc.activeLayerId).toBe("layer-2");
    const pixelsOf = (i: number) => Array.from(doc.layerData.layers.get(`layer-${i}`)!.data);
    expect(pixelsOf(0)).toEqual(Array.from(a));
    expect(pixelsOf(1)).toEqual(Array.from(b));
    expect(pixelsOf(2)).toEqual(Array.from(c));
    expect(doc.layerData.layers.get("layer-0")!.geo).toEqual({ layerWidth: 2, layerHeight: 1, offsetX: 0, offsetY: 0 });
  });

  it("disambiguates two names that are equal after trimming", async () => {
    const px = new Float32Array(4);
    const doc = await decodeExrDocument(
      await encodeExrLayers([{ name: "Paint", pixels: px }, { name: " Paint", pixels: px }], 1, 1),
    );
    expect(doc.layers.map((l) => l.name)).toEqual(["Paint", "Paint (2)"]);
  });

  it("gives three names that are equal after trimming three unique names", async () => {
    const px = new Float32Array(4);
    const doc = await decodeExrDocument(
      await encodeExrLayers(
        [
          { name: "Paint", pixels: px },
          { name: " Paint", pixels: px },
          { name: "Paint ", pixels: px },
        ],
        1,
        1,
      ),
    );
    expect(new Set(doc.layers.map((l) => l.name)).size).toBe(3);
  });

  it("names the single layer of a plain RGBA EXR “Background”", async () => {
    const doc = await decodeExrDocument(await encodeExr(new Float32Array([4, 0, 0, 1]), 1, 1));
    expect(doc.layers.map((l) => l.name)).toEqual(["Background"]);
    expect(Array.from(doc.layerData.layers.get("layer-0")!.data)).toEqual([4, 0, 0, 1]);
  });
});
