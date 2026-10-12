// PSD writer (exportPsd) ↔ reader (psdLoader), cross-checked with ag-psd.
import { beforeAll, describe, expect, it } from "vitest";
import { initializeCanvas, readPsd } from "ag-psd";
import type { BlendMode } from "@/types";
import { exportPsd, type PsdExportInput, type PsdExportText } from "@/core/io/exportPsd";
import { loadPsdLayers, type PsdImportedGroup, type PsdImportedLayer, type PsdImportedText } from "@/core/io/psdLoader";

function rgba8(w: number, h: number, seed: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < out.length; i++) out[i] = (i * 13 + seed * 101) & 0xff;
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return out;
}

const ab = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const textNode = (over: Partial<PsdExportText["text"]> = {}): PsdExportText => ({
  kind: "text",
  name: "Heading",
  visible: true,
  opacity: 0.8,
  blendMode: "multiply",
  text: {
    text: "Hello PSD",
    x: 12,
    y: 30,
    boxWidth: 0,
    boxHeight: 0,
    fontFamily: "ArialMT",
    fontSize: 24,
    bold: false,
    italic: false,
    underline: true,
    strikethrough: false,
    align: "center",
    letterSpacing: 2.4,
    lineHeight: 1.5,
    kerning: "auto",
    color: { r: 1, g: 0.5, b: 0, a: 1 },
    horizontalScale: 110,
    verticalScale: 90,
    baselineShift: 2,
    fauxBold: true,
    fauxItalic: false,
    allCaps: true,
    smallCaps: false,
    superscript: false,
    subscript: true,
    antiAlias: "crisp",
    strokeColor: { r: 0, g: 0, b: 1, a: 1 },
    strokeWidth: 3,
    ligatures: "none",
    firstLineIndent: 4,
    leftIndent: 5,
    rightIndent: 6,
    spaceBefore: 7,
    spaceAfter: 8,
    hyphenate: true,
    noBreak: false,
    ...over,
  },
});

// ag-psd allocates decoded pixel buffers through a canvas'
// `createImageData` (the renderer has one). Node has no canvas: give it the
// same { width, height, data } shape. Nothing here draws.
beforeAll(() => {
  initializeCanvas(
    () => {
      throw new Error("no canvas in tests");
    },
    (width: number, height: number) =>
      ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as unknown as ImageData,
  );
});

describe("exportPsd → loadPsdLayers", () => {
  it("round-trips pixel layers (odd sizes, offsets, blend, opacity, visibility) bit-exactly", () => {
    const a = rgba8(5, 3, 1);
    const b = rgba8(1, 1, 2);
    const input: PsdExportInput = {
      width: 9,
      height: 7,
      layers: [
        { kind: "layer", name: "Bottom", visible: true, opacity: 1, blendMode: "normal", pixels: a, layerWidth: 5, layerHeight: 3, offsetX: 2, offsetY: 1 },
        { kind: "layer", name: "Tïny", visible: false, opacity: 0.5, blendMode: "color-dodge", pixels: b, layerWidth: 1, layerHeight: 1, offsetX: 8, offsetY: 6 },
      ],
    };
    const res = loadPsdLayers(ab(exportPsd(input)));
    expect([res.width, res.height]).toEqual([9, 7]);
    expect(res.hadUnsupportedLayers).toBe(false);
    expect(res.nodes).toHaveLength(2);
    const [l0, l1] = res.nodes as PsdImportedLayer[];
    expect(l0).toMatchObject({ kind: "layer", name: "Bottom", visible: true, opacity: 1, blendMode: "normal", layerWidth: 5, layerHeight: 3, offsetX: 2, offsetY: 1 });
    expect(l0.pixels).toEqual(a);
    expect(l1).toMatchObject({ name: "Tïny", visible: false, blendMode: "color-dodge", offsetX: 8, offsetY: 6 });
    // PSD stores opacity as a byte.
    expect(Math.abs(l1.opacity - 0.5)).toBeLessThanOrEqual(1 / 255);
    expect(l1.pixels).toEqual(b);
  });

  it("round-trips partial and zero alpha", () => {
    const px = new Uint8Array([255, 0, 0, 128, 0, 255, 0, 0, 1, 2, 3, 1, 9, 9, 9, 255]);
    const res = loadPsdLayers(
      ab(exportPsd({ width: 2, height: 2, layers: [{ kind: "layer", name: "A", visible: true, opacity: 1, blendMode: "normal", pixels: px, layerWidth: 2, layerHeight: 2, offsetX: 0, offsetY: 0 }] })),
    );
    const l = res.nodes[0] as PsdImportedLayer;
    // Alpha is exact; colour under alpha 0 is not guaranteed by PSD.
    for (let i = 3; i < 16; i += 4) expect(l.pixels[i]).toBe(px[i]);
    expect(Array.from(l.pixels.subarray(0, 3))).toEqual([255, 0, 0]);
    expect(Array.from(l.pixels.subarray(12, 16))).toEqual([9, 9, 9, 255]);
  });

  it("maps every supported blend mode both ways", () => {
    const modes: BlendMode[] = ["normal", "multiply", "screen", "overlay", "soft-light", "hard-light", "darken", "lighten", "difference", "exclusion", "color-dodge", "color-burn"];
    const res = loadPsdLayers(
      ab(
        exportPsd({
          width: 1,
          height: 1,
          layers: modes.map((m) => ({ kind: "layer" as const, name: m, visible: true, opacity: 1, blendMode: m, pixels: new Uint8Array([1, 2, 3, 255]), layerWidth: 1, layerHeight: 1, offsetX: 0, offsetY: 0 })),
        }),
      ),
    );
    expect(res.nodes.map((n) => (n as PsdImportedLayer).blendMode)).toEqual(modes);
  });

  it("round-trips a layer mask (position, size, values)", () => {
    const maskPx = new Uint8Array([0, 64, 128, 255, 255, 0]);
    const res = loadPsdLayers(
      ab(
        exportPsd({
          width: 6,
          height: 6,
          layers: [
            {
              kind: "layer",
              name: "Masked",
              visible: true,
              opacity: 1,
              blendMode: "normal",
              pixels: rgba8(4, 4, 3),
              layerWidth: 4,
              layerHeight: 4,
              offsetX: 1,
              offsetY: 1,
              mask: { pixels: maskPx, width: 3, height: 2, offsetX: 2, offsetY: 3 },
            },
          ],
        }),
      ),
    );
    const l = res.nodes[0] as PsdImportedLayer;
    expect(l.mask).toBeDefined();
    expect(l.mask!).toMatchObject({ width: 3, height: 2, offsetX: 2, offsetY: 3, defaultColor: 0 });
    expect(l.mask!.pixels).toEqual(maskPx);
  });

  it("round-trips nested groups in bottom-first order", () => {
    const leaf = (name: string) => ({ kind: "layer" as const, name, visible: true, opacity: 1, blendMode: "normal" as const, pixels: rgba8(2, 2, name.length), layerWidth: 2, layerHeight: 2, offsetX: 0, offsetY: 0 });
    const res = loadPsdLayers(
      ab(
        exportPsd({
          width: 2,
          height: 2,
          layers: [
            leaf("bg"),
            {
              kind: "group",
              name: "Outer",
              visible: true,
              opacity: 1,
              blendMode: "normal",
              opened: false,
              children: [leaf("a"), { kind: "group", name: "Inner", visible: false, opacity: 1, blendMode: "normal", opened: true, children: [leaf("bb")] }],
            },
            leaf("top"),
          ],
        }),
      ),
    );
    const names = res.nodes.map((n) => n.name);
    expect(names).toEqual(["bg", "Outer", "top"]);
    const outer = res.nodes[1] as PsdImportedGroup;
    expect(outer.kind).toBe("group");
    expect(outer.collapsed).toBe(true);
    expect(outer.children.map((c) => c.name)).toEqual(["a", "Inner"]);
    const inner = outer.children[1] as PsdImportedGroup;
    expect(inner.visible).toBe(false);
    expect(inner.collapsed).toBe(false);
    expect((inner.children[0] as PsdImportedLayer).pixels).toEqual(rgba8(2, 2, 2));
    // Ids are unique.
    const ids: string[] = [];
    const walk = (ns: typeof res.nodes) => ns.forEach((n) => (ids.push(n.id), n.kind === "group" && walk(n.children)));
    walk(res.nodes);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps empty groups", () => {
    const res = loadPsdLayers(
      ab(exportPsd({ width: 2, height: 2, layers: [{ kind: "group", name: "Empty", visible: true, opacity: 1, blendMode: "normal", opened: true, children: [] }] })),
    );
    expect(res.nodes).toHaveLength(1);
    expect(res.nodes[0]).toMatchObject({ kind: "group", name: "Empty", children: [] });
  });

  it("round-trips live text attributes (8-bit colours)", () => {
    const src = textNode();
    const res = loadPsdLayers(ab(exportPsd({ width: 100, height: 60, layers: [src] })));
    const t = res.nodes[0] as PsdImportedText;
    expect(t.kind).toBe("text");
    expect(t.name).toBe("Heading");
    expect(t.blendMode).toBe("multiply");
    expect(Math.abs(t.opacity - 0.8)).toBeLessThanOrEqual(1 / 255);
    const s = src.text;
    expect(t.text).toMatchObject({
      text: s.text,
      x: s.x,
      y: s.y,
      fontFamily: s.fontFamily,
      underline: true,
      strikethrough: false,
      align: "center",
      kerning: "auto",
      baselineShift: 2,
      fauxBold: true,
      fauxItalic: false,
      allCaps: true,
      smallCaps: false,
      subscript: true,
      superscript: false,
      antiAlias: "crisp",
      strokeWidth: 3,
      ligatures: "none",
      firstLineIndent: 4,
      leftIndent: 5,
      rightIndent: 6,
      spaceBefore: 7,
      spaceAfter: 8,
      hyphenate: true,
      noBreak: false,
    });
    expect(t.text.fontSize).toBeCloseTo(24, 4);
    expect(t.text.lineHeight).toBeCloseTo(1.5, 4);
    expect(t.text.verticalScale).toBeCloseTo(90, 4);
    expect(t.text.horizontalScale).toBeCloseTo(110, 4);
    // Tracking is stored in 1/1000 em: 2.4 px at 24 px = 100 milliems.
    expect(t.text.letterSpacing).toBeCloseTo(2.4, 4);
    expect(t.text.color.r).toBeCloseTo(1, 2);
    expect(t.text.color.g).toBeCloseTo(128 / 255, 2);
    expect(t.text.color.b).toBeCloseTo(0, 2);
    expect(t.text.strokeColor!.b).toBeCloseTo(1, 2);
  });

  it("round-trips area-text boxes", () => {
    const res = loadPsdLayers(ab(exportPsd({ width: 100, height: 100, layers: [textNode({ boxWidth: 80, boxHeight: 40, ligatures: "all", align: "justify" })] })));
    const t = (res.nodes[0] as PsdImportedText).text;
    expect([t.boxWidth, t.boxHeight]).toEqual([80, 40]);
    expect(t.ligatures).toBe("all");
    expect(t.align).toBe("justify");
  });

  it("exports live text from a 32-bit document", () => {
    const res = loadPsdLayers(
      ab(exportPsd({ width: 10, height: 10, bitsPerChannel: 32, layers: [textNode({ color: { r: 1, g: 0.25, b: 0, a: 1 } })] })),
    );
    const c = (res.nodes[0] as PsdImportedText).text.color;
    expect(c.r).toBeCloseTo(1, 2);
    expect(c.g).toBeCloseTo(0.25, 2);
  });

  it("writes an 8-bit RGB PSD that ag-psd reads independently", () => {
    const px = rgba8(3, 2, 7);
    const file = exportPsd({ width: 3, height: 2, layers: [{ kind: "layer", name: "L", visible: true, opacity: 1, blendMode: "screen", pixels: px, layerWidth: 3, layerHeight: 2, offsetX: 0, offsetY: 0 }] });
    expect(new TextDecoder().decode(file.subarray(0, 4))).toBe("8BPS");
    const psd = readPsd(ab(file), { useImageData: true, skipCompositeImageData: true });
    expect([psd.width, psd.height, psd.bitsPerChannel, psd.colorMode]).toEqual([3, 2, 8, 3]);
    expect(psd.children![0].blendMode).toBe("screen");
    expect(new Uint8Array(psd.children![0].imageData!.data.buffer)).toEqual(px);
  });

  it("an empty document round-trips with no layers", () => {
    const res = loadPsdLayers(ab(exportPsd({ width: 4, height: 3, layers: [] })));
    expect([res.width, res.height]).toEqual([4, 3]);
    expect(res.nodes).toEqual([]);
    expect(res.iccProfile).toBeUndefined();
  });

  it("rejects non-PSD data", () => {
    expect(() => loadPsdLayers(new Uint8Array([1, 2, 3, 4, 5, 6]).buffer)).toThrow();
  });
});
