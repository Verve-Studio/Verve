// PDF exporter: file structure (xref / trailer), image payloads (RGB +
// SMask), ICC embedding, and the text / shape content streams.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShapeLayerState, TextLayerState } from "@/types";
import { inflate } from "@/utils/zlib";
import { exportPdf, type PdfExportNode } from "@/core/io/exportPdf";

const latin1 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");

interface PdfObject {
  dict: string;
  stream: Uint8Array | null;
}

/** Parse the objects of a PDF written by exportPdf via its xref table, and
 *  check that every xref offset points at the right "N 0 obj". */
function parsePdf(bytes: Uint8Array): { objects: Map<number, PdfObject>; trailer: string; text: string } {
  const text = latin1(bytes);
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
  expect(text.slice(startxref, startxref + 4)).toBe("xref");
  const xref = /xref\n0 (\d+)\n([\s\S]*?)trailer\n([\s\S]*?)\nstartxref/.exec(text.slice(startxref))!;
  const count = Number(xref[1]);
  const entries = xref[2].trim().split("\n");
  expect(entries).toHaveLength(count);
  expect(entries[0]).toBe("0000000000 65535 f ");
  const objects = new Map<number, PdfObject>();
  for (let n = 1; n < count; n++) {
    const off = Number(entries[n].slice(0, 10));
    const head = `${n} 0 obj\n`;
    expect(text.slice(off, off + head.length), `object ${n}`).toBe(head);
    const end = text.indexOf("\nendobj\n", off);
    const body = text.slice(off + head.length, end);
    const si = body.indexOf("\nstream\n");
    if (si < 0) {
      objects.set(n, { dict: body, stream: null });
    } else {
      const dict = body.slice(0, si);
      const len = Number(/\/Length (\d+)/.exec(dict)![1]);
      const start = off + head.length + si + "\nstream\n".length;
      expect(text.slice(start + len, start + len + "\nendstream".length)).toBe("\nendstream");
      objects.set(n, { dict, stream: bytes.slice(start, start + len) });
    }
  }
  expect(xref[3]).toContain(`/Size ${count}`);
  return { objects, trailer: xref[3], text };
}

async function contentOf(objects: Map<number, PdfObject>): Promise<string> {
  return latin1(await inflate(objects.get(4)!.stream!));
}

const base = { id: "l", name: "L", visible: true, opacity: 1, locked: false, blendMode: "normal" as const };

function textLayer(over: Partial<TextLayerState> = {}): TextLayerState {
  return {
    ...base,
    type: "text",
    text: "Hi (there)\\",
    x: 10,
    y: 20,
    boxWidth: 0,
    boxHeight: 0,
    fontFamily: "Arial",
    fontSize: 10,
    bold: true,
    italic: false,
    underline: false,
    strikethrough: false,
    align: "left",
    letterSpacing: 0,
    lineHeight: 1.2,
    kerning: "auto",
    color: { r: 1, g: 0.5, b: 0, a: 1 },
    ...over,
  };
}

function shapeLayer(over: Partial<ShapeLayerState> = {}): ShapeLayerState {
  return {
    ...base,
    type: "shape",
    shapeType: "rectangle",
    cx: 50,
    cy: 40,
    w: 20,
    h: 10,
    rotation: 0,
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
    strokeColor: null,
    fillColor: { r: 255, g: 0, b: 0, a: 255 },
    strokeWidth: 0,
    cornerRadius: 0,
    antiAlias: true,
    ...over,
  };
}

beforeEach(() => {
  // Text measurement uses a 2D canvas in the renderer; in Node give it one
  // without a context so the exporter's documented fallback width is used.
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
});

describe("exportPdf", () => {
  it("writes a single-page PDF whose xref points at every object", async () => {
    const pdf = await exportPdf({ width: 120, height: 80, nodes: [] });
    expect(latin1(pdf.subarray(0, 9))).toBe("%PDF-1.4\n");
    const { objects, trailer } = parsePdf(pdf);
    expect(trailer).toContain("/Root 1 0 R");
    expect(objects.get(1)!.dict).toContain("/Type /Catalog");
    expect(objects.get(2)!.dict).toContain("/Kids [3 0 R] /Count 1");
    expect(objects.get(3)!.dict).toContain("/MediaBox [0 0 120 80]");
  });

  it("embeds image layers losslessly as RGB + SMask, placed with a Y-flip", async () => {
    const w = 3;
    const h = 2;
    const pixels = new Uint8Array(w * h * 4);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37 + 5) & 255;
    const nodes: PdfExportNode[] = [
      { kind: "image", pixels, width: w, height: h, x: 5, y: 7, layerOpacity: 0.5, blendMode: "multiply" },
    ];
    const { objects } = parsePdf(await exportPdf({ width: 20, height: 10, nodes }));

    const image = [...objects.values()].find((o) => /\/SMask \d+ 0 R/.test(o.dict))!;
    expect(image.dict).toContain(`/Width ${w} /Height ${h}`);
    expect(image.dict).toContain("/ColorSpace /DeviceRGB");
    const smaskId = Number(/\/SMask (\d+) 0 R/.exec(image.dict)![1]);
    const smask = objects.get(smaskId)!;
    expect(smask.dict).toContain("/ColorSpace /DeviceGray");

    const rgb = await inflate(image.stream!);
    const alpha = await inflate(smask.stream!);
    for (let i = 0; i < w * h; i++) {
      expect(Array.from(rgb.subarray(i * 3, i * 3 + 3))).toEqual(Array.from(pixels.subarray(i * 4, i * 4 + 3)));
      expect(alpha[i]).toBe(pixels[i * 4 + 3]);
    }

    const content = await contentOf(objects);
    // y_pdf = pageHeight - y - h = 10 - 7 - 2 = 1
    expect(content).toContain(`${w} 0 0 ${h} 5 1 cm\n/Im1 Do`);
    const gs = [...objects.values()].find((o) => o.dict.includes("/Type /ExtGState"))!;
    expect(gs.dict).toContain("/ca 0.5 /CA 0.5 /BM /Multiply");
  });

  it("embeds the ICC profile and uses it for images and DefaultRGB", async () => {
    const icc = new Uint8Array(300).map((_, i) => i & 255);
    const { objects } = parsePdf(
      await exportPdf({
        width: 2,
        height: 2,
        iccProfile: icc,
        nodes: [{ kind: "image", pixels: new Uint8Array(16).fill(200), width: 2, height: 2, x: 0, y: 0, layerOpacity: 1, blendMode: "normal" }],
      }),
    );
    const [iccId, iccObj] = [...objects.entries()].find(([, o]) => o.dict.includes("/Alternate /DeviceRGB"))!;
    expect(iccObj.dict).toContain("/N 3");
    expect(await inflate(iccObj.stream!)).toEqual(icc);
    expect(objects.get(3)!.dict).toContain(`/DefaultRGB [/ICCBased ${iccId} 0 R]`);
    const image = [...objects.values()].find((o) => o.dict.includes("/SMask"))!;
    expect(image.dict).toContain(`/ColorSpace [/ICCBased ${iccId} 0 R]`);
  });

  it("emits live text with a Base-14 font, escaped strings and page-space baselines", async () => {
    const { objects } = parsePdf(
      await exportPdf({ width: 100, height: 50, nodes: [{ kind: "text", layer: textLayer(), layerOpacity: 1, blendMode: "normal" }] }),
    );
    const font = [...objects.values()].find((o) => o.dict.includes("/Type /Font"))!;
    expect(font.dict).toContain("/BaseFont /Helvetica-Bold");
    const content = await contentOf(objects);
    expect(content).toContain("/F1 10 Tf");
    expect(content).toContain("1 0.5 0 rg");
    // Baseline: y + 0.8 × fontSize = 28 → 50 − 28 = 22.
    expect(content).toContain("1 0 0 1 10 22 Tm\n(Hi \\(there\\)\\\\) Tj");
    expect(objects.get(3)!.dict).toMatch(/\/Font << \/F1 \d+ 0 R >>/);
  });

  it("skips text it can't encode in WinAnsi (the caller rasterises it)", async () => {
    const { objects } = parsePdf(
      await exportPdf({ width: 10, height: 10, nodes: [{ kind: "text", layer: textLayer({ text: "日本" }), layerOpacity: 1, blendMode: "normal" }] }),
    );
    expect(await contentOf(objects)).not.toContain("Tj");
  });

  it("emits filled vector shapes in page space", async () => {
    const { objects } = parsePdf(
      await exportPdf({ width: 100, height: 100, nodes: [{ kind: "shape", layer: shapeLayer(), layerOpacity: 1, blendMode: "normal" }] }),
    );
    const content = await contentOf(objects);
    expect(content).toContain("1 0 0 rg");
    // Centre (50, 40) → page (50, 60); a 20×10 rect around it.
    expect(content).toContain("1 0 0 1 50 60 cm\n-10 -5 20 10 re f");
  });

  it("defines the shading resource used by a gradient fill", async () => {
    const layer = shapeLayer({
      fillColor: null,
      fillGradient: {
        type: "linear",
        startX: 0,
        startY: 0,
        endX: 1,
        endY: 0,
        stops: [
          { offset: 0, color: { r: 255, g: 0, b: 0, a: 255 } },
          { offset: 1, color: { r: 0, g: 0, b: 255, a: 255 } },
        ],
      },
    });
    const { objects } = parsePdf(await exportPdf({ width: 100, height: 100, nodes: [{ kind: "shape", layer, layerOpacity: 1, blendMode: "normal" }] }));
    expect(await contentOf(objects)).toContain("/Sh1 sh");
    expect(objects.get(3)!.dict).toMatch(/\/Shading << \/Sh1 \d+ 0 R/);
  });

  it("exports HDR text colours clamped, not divided by 255", async () => {
    const { objects } = parsePdf(
      await exportPdf({
        width: 100,
        height: 50,
        nodes: [{ kind: "text", layer: textLayer({ color: { r: 2, g: 0.5, b: 0, a: 1 } }), layerOpacity: 1, blendMode: "normal" }],
      }),
    );
    const rg = /([\d.]+) ([\d.]+) ([\d.]+) rg/.exec(await contentOf(objects))!;
    expect(Number(rg[1])).toBeGreaterThan(0.99);
  });
});
