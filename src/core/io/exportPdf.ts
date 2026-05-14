// PDF 1.4 exporter — emits text layers as live PDF text, shape layers as
// vector paths, and any other pixel-bearing layer (raster / frame / group /
// composite / text-with-attached-adjustments) as embedded RGB images with
// soft masks. Page size matches the canvas in points (1 px = 1 pt @ 72 DPI).

import type {
  TextLayerState,
  ShapeLayerState,
  PathLayerState,
  RGBAColor,
  TextAlign,
  BlendMode,
  Gradient,
} from "@/types";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface PdfExportInput {
  width: number;
  height: number;
  /** Bottom-first z-order: nodes[0] is drawn first (appears underneath). */
  nodes: PdfExportNode[];
  /** Optional 3-channel RGB ICC profile bytes. When present, embedded as an
   *  ICCBased color space, used as `DefaultRGB` for text/shape fills, and as
   *  the `/ColorSpace` of every image XObject so RGB content is colour-managed
   *  by viewers like Acrobat / Preview. */
  iccProfile?: Uint8Array;
}

export type PdfExportNode =
  | PdfTextNode
  | PdfShapeNode
  | PdfPathNode
  | PdfImageNode;

export interface PdfTextNode {
  kind: "text";
  layer: TextLayerState;
  /** Multiplied through with text colour alpha when emitting the run. */
  layerOpacity: number;
  blendMode: BlendMode;
}

export interface PdfShapeNode {
  kind: "shape";
  layer: ShapeLayerState;
  layerOpacity: number;
  blendMode: BlendMode;
}

export interface PdfPathNode {
  kind: "path";
  layer: PathLayerState;
  layerOpacity: number;
  blendMode: BlendMode;
}

export interface PdfImageNode {
  kind: "image";
  /** RGBA8 pixels, top-down, tightly packed. */
  pixels: Uint8Array;
  width: number;
  height: number;
  /** Top-left of the image in canvas pixels. */
  x: number;
  y: number;
  layerOpacity: number;
  blendMode: BlendMode;
}

/** Verve blend modes → PDF /BM names. PDF supports the 12 standard Adobe
 *  modes; `pass-through` has no PDF equivalent and falls back to Normal. */
function pdfBlendModeName(b: BlendMode): string {
  switch (b) {
    case "multiply":
      return "Multiply";
    case "screen":
      return "Screen";
    case "overlay":
      return "Overlay";
    case "soft-light":
      return "SoftLight";
    case "hard-light":
      return "HardLight";
    case "darken":
      return "Darken";
    case "lighten":
      return "Lighten";
    case "difference":
      return "Difference";
    case "exclusion":
      return "Exclusion";
    case "color-dodge":
      return "ColorDodge";
    case "color-burn":
      return "ColorBurn";
    case "normal":
    case "pass-through":
    default:
      return "Normal";
  }
}

// ─── PDF primitive helpers ────────────────────────────────────────────────────

async function deflate(input: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(input as unknown as BufferSource);
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// PDF literal-string escaping for WinAnsi text.
function escapePdfLiteral(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" || ch === "(" || ch === ")") out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out;
}

function isAsciiRenderable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 126 && c !== 10 && c !== 13 && c !== 9) return false;
    if (c < 32 && c !== 10 && c !== 13 && c !== 9) return false;
  }
  return true;
}

// ─── Font mapping (PDF Base14) ────────────────────────────────────────────────

type BaseFontFamily = "Helvetica" | "Times" | "Courier";

function pickBaseFamily(fontFamily: string): BaseFontFamily {
  const f = fontFamily.toLowerCase();
  if (f.includes("mono") || f.includes("courier") || f.includes("consola"))
    return "Courier";
  if (
    f.includes("serif") ||
    f.includes("times") ||
    f.includes("georgia") ||
    f.includes("garamond") ||
    f.includes("cambria")
  )
    return "Times";
  return "Helvetica";
}

function baseFontName(
  family: BaseFontFamily,
  bold: boolean,
  italic: boolean,
): string {
  if (family === "Helvetica") {
    if (bold && italic) return "Helvetica-BoldOblique";
    if (bold) return "Helvetica-Bold";
    if (italic) return "Helvetica-Oblique";
    return "Helvetica";
  }
  if (family === "Times") {
    if (bold && italic) return "Times-BoldItalic";
    if (bold) return "Times-Bold";
    if (italic) return "Times-Italic";
    return "Times-Roman";
  }
  if (bold && italic) return "Courier-BoldOblique";
  if (bold) return "Courier-Bold";
  if (italic) return "Courier-Oblique";
  return "Courier";
}

// ─── Color helpers ────────────────────────────────────────────────────────────

function rgbForPdf(c: RGBAColor): [number, number, number] {
  // Verve stores text/shape colours in either 0–255 (LDR docs) or 0–∞ float
  // (HDR / >1 valid). Detect by magnitude: anything > 1 is treated as 0–255.
  const max = Math.max(c.r, c.g, c.b);
  if (max > 1.0001) {
    return [
      clamp01(c.r / 255),
      clamp01(c.g / 255),
      clamp01(c.b / 255),
    ];
  }
  return [clamp01(c.r), clamp01(c.g), clamp01(c.b)];
}

function alphaForPdf(c: RGBAColor): number {
  // Same heuristic — alpha is 0–255 in LDR documents but 0–1 for HDR floats.
  return c.a > 1.0001 ? clamp01(c.a / 255) : clamp01(c.a);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  // Trim to 4 decimals — small enough for PDF, large enough for any
  // shape geometry we emit.
  const r = Math.round(n * 10000) / 10000;
  return Number.isInteger(r) ? r.toString() : r.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

// ─── Text measurement (for align centre/right) ────────────────────────────────

let measureCtx: CanvasRenderingContext2D | null = null;

function measureText(s: string, fontPx: number, bold: boolean, italic: boolean, family: string): number {
  if (!measureCtx) {
    const c = document.createElement("canvas");
    measureCtx = c.getContext("2d");
  }
  if (!measureCtx) return s.length * fontPx * 0.5;
  const style = `${italic ? "italic " : ""}${bold ? "bold " : ""}${fontPx}px ${family}`;
  measureCtx.font = style;
  return measureCtx.measureText(s).width;
}

// ─── Content-stream emitters ──────────────────────────────────────────────────

interface BuildContext {
  pageHeight: number;
  /** Maps base font name → font resource id (e.g. "F1"). */
  fontIds: Map<string, string>;
  /** Maps an opacity tuple "<fillA>:<strokeA>" → ExtGState resource id. */
  gStateIds: Map<string, string>;
  /** Image XObject names in resource order, e.g. ["Im1", "Im2"]. */
  imageNames: string[];
  /** Shadings collected for vector gradient fills. Emitted as resource
   *  `/Sh<n>` and serialized into PDF Shading + Function objects later. */
  shadings: { name: string; gradient: Gradient }[];
}

function ensureShading(ctx: BuildContext, g: Gradient): string {
  const name = `Sh${ctx.shadings.length + 1}`;
  ctx.shadings.push({ name, gradient: g });
  return name;
}

/**
 * Emit the path of a closed shape/path layer in canvas-space (post-Y-flip)
 * straight onto the content stream, without painting it. Used as the inner
 * helper for gradient fills, which clip to the path and then paint a
 * shading inside it. Coordinate space is the PDF page (Y-up).
 */
function buildPathInPageSpace_shape(
  ctx: BuildContext,
  s: ShapeLayerState,
): string {
  // Mirrors emitShapeNode's path geometry but emits in page-space coords
  // directly (no translate/rotate cm), so the resulting path can sit under
  // a `W n` clip while we paint the shading in canvas space.
  const pageH = ctx.pageHeight;
  const flip = (y: number): number => pageH - y;
  if (s.shapeType === "line") {
    // Lines don't fill — gradient fills only apply to closed shapes.
    return "";
  }
  // Rotate the bounding-box corners around the centre, then emit them.
  const θ = (s.rotation * Math.PI) / 180;
  const c = Math.cos(θ);
  const si = Math.sin(θ);
  const hw = s.w / 2;
  const hh = s.h / 2;
  const rotate = (lx: number, ly: number): [number, number] => {
    // Canvas-CW rotation. (lx, ly) is in local frame (Y-down).
    const wx = s.cx + (c * lx - si * ly);
    const wy = s.cy + (si * lx + c * ly);
    return [wx, flip(wy)];
  };
  const cubic = (
    p0: [number, number],
    p1: [number, number],
    p2: [number, number],
    p3: [number, number],
  ): string =>
    `${fmt(p0[0])} ${fmt(p0[1])} m\n` +
    `${fmt(p1[0])} ${fmt(p1[1])} ${fmt(p2[0])} ${fmt(p2[1])} ` +
    `${fmt(p3[0])} ${fmt(p3[1])} c\n`;
  const k = 0.5522847498307936;
  let out = "";
  if (s.shapeType === "rectangle") {
    const r = Math.max(0, Math.min(s.cornerRadius, Math.min(hw, hh)));
    if (r <= 0) {
      const p0 = rotate(-hw, -hh);
      const p1 = rotate(hw, -hh);
      const p2 = rotate(hw, hh);
      const p3 = rotate(-hw, hh);
      out += `${fmt(p0[0])} ${fmt(p0[1])} m\n`;
      out += `${fmt(p1[0])} ${fmt(p1[1])} l\n`;
      out += `${fmt(p2[0])} ${fmt(p2[1])} l\n`;
      out += `${fmt(p3[0])} ${fmt(p3[1])} l\n`;
      out += "h\n";
    } else {
      // Rounded rect — 4 cubic-Bezier corners.
      const kr = k * r;
      const segs: [number, number][][] = [
        // top edge then top-right corner
        [
          [-hw + r, -hh],
          [hw - r, -hh],
        ],
        [
          [hw - r + kr, -hh],
          [hw, -hh + r - kr],
          [hw, -hh + r],
        ],
        // right edge then bottom-right corner
        [
          [hw, hh - r],
        ],
        [
          [hw, hh - r + kr],
          [hw - r + kr, hh],
          [hw - r, hh],
        ],
        // bottom edge then bottom-left corner
        [
          [-hw + r, hh],
        ],
        [
          [-hw + r - kr, hh],
          [-hw, hh - r + kr],
          [-hw, hh - r],
        ],
        // left edge then top-left corner
        [
          [-hw, -hh + r],
        ],
        [
          [-hw, -hh + r - kr],
          [-hw + r - kr, -hh],
          [-hw + r, -hh],
        ],
      ];
      let started = false;
      for (const seg of segs) {
        if (!started) {
          const p0 = rotate(seg[0][0], seg[0][1]);
          out += `${fmt(p0[0])} ${fmt(p0[1])} m\n`;
          started = true;
          if (seg.length === 1) continue;
          if (seg.length === 2) {
            const p1 = rotate(seg[1][0], seg[1][1]);
            out += `${fmt(p1[0])} ${fmt(p1[1])} l\n`;
            continue;
          }
        }
        if (seg.length === 1) {
          const p = rotate(seg[0][0], seg[0][1]);
          out += `${fmt(p[0])} ${fmt(p[1])} l\n`;
        } else if (seg.length === 2) {
          const p = rotate(seg[1][0], seg[1][1]);
          out += `${fmt(p[0])} ${fmt(p[1])} l\n`;
        } else if (seg.length === 3) {
          const a = rotate(seg[0][0], seg[0][1]);
          const b = rotate(seg[1][0], seg[1][1]);
          const c2 = rotate(seg[2][0], seg[2][1]);
          out += `${fmt(a[0])} ${fmt(a[1])} ${fmt(b[0])} ${fmt(b[1])} ${fmt(c2[0])} ${fmt(c2[1])} c\n`;
        }
      }
      out += "h\n";
    }
  } else if (s.shapeType === "ellipse") {
    const kx = k * hw;
    const ky = k * hh;
    // Four cubic arcs around the ellipse, starting at local (hw, 0).
    const start = rotate(hw, 0);
    out += `${fmt(start[0])} ${fmt(start[1])} m\n`;
    out += cubic(
      rotate(hw, 0),
      rotate(hw, ky),
      rotate(kx, hh),
      rotate(0, hh),
    ).split("\n").slice(1).join("\n");
    out += cubic(
      rotate(0, hh),
      rotate(-kx, hh),
      rotate(-hw, ky),
      rotate(-hw, 0),
    ).split("\n").slice(1).join("\n");
    out += cubic(
      rotate(-hw, 0),
      rotate(-hw, -ky),
      rotate(-kx, -hh),
      rotate(0, -hh),
    ).split("\n").slice(1).join("\n");
    out += cubic(
      rotate(0, -hh),
      rotate(kx, -hh),
      rotate(hw, -ky),
      rotate(hw, 0),
    ).split("\n").slice(1).join("\n");
    out += "h\n";
  } else if (s.shapeType === "triangle") {
    const p0 = rotate(0, -hh);
    const p1 = rotate(hw, hh);
    const p2 = rotate(-hw, hh);
    out += `${fmt(p0[0])} ${fmt(p0[1])} m\n`;
    out += `${fmt(p1[0])} ${fmt(p1[1])} l\n`;
    out += `${fmt(p2[0])} ${fmt(p2[1])} l\n`;
    out += "h\n";
  } else if (s.shapeType === "diamond") {
    const p0 = rotate(0, -hh);
    const p1 = rotate(hw, 0);
    const p2 = rotate(0, hh);
    const p3 = rotate(-hw, 0);
    out += `${fmt(p0[0])} ${fmt(p0[1])} m\n`;
    out += `${fmt(p1[0])} ${fmt(p1[1])} l\n`;
    out += `${fmt(p2[0])} ${fmt(p2[1])} l\n`;
    out += `${fmt(p3[0])} ${fmt(p3[1])} l\n`;
    out += "h\n";
  } else if (s.shapeType === "star") {
    const points = 5;
    const innerRatio = 0.5;
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? 1 : innerRatio;
      // In canvas-space (Y-down), first point is at top = (0, -hh*r).
      const angle = -Math.PI / 2 + (i * Math.PI) / points;
      const lx = Math.cos(angle) * r * hw;
      const ly = Math.sin(angle) * r * hh;
      const p = rotate(lx, ly);
      out += `${fmt(p[0])} ${fmt(p[1])} ${i === 0 ? "m" : "l"}\n`;
    }
    out += "h\n";
  }
  return out;
}

function ensureFont(ctx: BuildContext, name: string): string {
  let id = ctx.fontIds.get(name);
  if (!id) {
    id = `F${ctx.fontIds.size + 1}`;
    ctx.fontIds.set(name, id);
  }
  return id;
}

function ensureGState(
  ctx: BuildContext,
  fillA: number,
  strokeA: number,
  blendMode: BlendMode = "normal",
): string {
  const bm = pdfBlendModeName(blendMode);
  const key = `${fillA.toFixed(4)}:${strokeA.toFixed(4)}:${bm}`;
  let id = ctx.gStateIds.get(key);
  if (!id) {
    id = `G${ctx.gStateIds.size + 1}`;
    ctx.gStateIds.set(key, id);
  }
  return id;
}

function emitTextNode(ctx: BuildContext, node: PdfTextNode): string {
  const t = node.layer;
  if (!t.text) return "";
  if (!isAsciiRenderable(t.text)) {
    // Non-WinAnsi-safe characters — caller should have rasterized this
    // layer. Skip emission rather than mojibake the output.
    return "";
  }

  const family = pickBaseFamily(t.fontFamily);
  const fontName = baseFontName(family, t.bold, t.italic);
  const fontId = ensureFont(ctx, fontName);

  const fillA = alphaForPdf(t.color) * node.layerOpacity;
  const strokeA =
    t.strokeColor && t.strokeWidth && t.strokeWidth > 0
      ? alphaForPdf(t.strokeColor) * node.layerOpacity
      : 0;
  const gState = ensureGState(ctx, fillA, strokeA, node.blendMode);

  const [fr, fg, fb] = rgbForPdf(t.color);
  const lines = t.text.split(/\r?\n/);
  const lineHeightPx = t.fontSize * (t.lineHeight || 1.2);
  const ascentPx = t.fontSize * 0.8;

  // Stroke params
  const hasStroke = t.strokeColor && (t.strokeWidth ?? 0) > 0;
  let strokeR = 0,
    strokeG = 0,
    strokeB = 0,
    strokeW = 0;
  if (hasStroke && t.strokeColor) {
    [strokeR, strokeG, strokeB] = rgbForPdf(t.strokeColor);
    strokeW = t.strokeWidth ?? 0;
  }

  // PDF rendering mode: 0 = fill, 1 = stroke, 2 = fill+stroke.
  const renderMode = hasStroke ? 2 : 0;

  let out = "";
  out += "q\n";
  out += `/${gState} gs\n`;
  out += `${fmt(fr)} ${fmt(fg)} ${fmt(fb)} rg\n`;
  if (hasStroke) {
    out += `${fmt(strokeR)} ${fmt(strokeG)} ${fmt(strokeB)} RG\n`;
    out += `${fmt(strokeW)} w\n`;
  }
  out += "BT\n";
  out += `/${fontId} ${fmt(t.fontSize)} Tf\n`;
  if (renderMode !== 0) out += `${renderMode} Tr\n`;
  if (t.letterSpacing) out += `${fmt(t.letterSpacing)} Tc\n`;

  // PDF user space and text space are both Y-up — no glyph flip needed.
  // For each line, place the baseline at canvas (xCanvas, y + ascent +
  // i * lineHeight) and convert to user space as (xCanvas, pageHeight - …).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    const lineWidth = measureText(line, t.fontSize, t.bold, t.italic, t.fontFamily);
    let xCanvas = t.x;
    if (t.boxWidth > 0) {
      if (t.align === "center")
        xCanvas = t.x + (t.boxWidth - lineWidth) / 2;
      else if (t.align === "right")
        xCanvas = t.x + t.boxWidth - lineWidth;
    } else if (t.align === "center") {
      xCanvas = t.x - lineWidth / 2;
    } else if (t.align === "right") {
      xCanvas = t.x - lineWidth;
    }
    const yCanvas = t.y + ascentPx + i * lineHeightPx;
    const yPdf = ctx.pageHeight - yCanvas;
    out += `1 0 0 1 ${fmt(xCanvas)} ${fmt(yPdf)} Tm\n`;
    out += `(${escapePdfLiteral(line)}) Tj\n`;
  }

  out += "ET\n";

  // Underline / strikethrough — drawn as filled rectangles in canvas space.
  if (t.underline || t.strikethrough) {
    const thickness = Math.max(1, t.fontSize * 0.06);
    out += `${fmt(fr)} ${fmt(fg)} ${fmt(fb)} rg\n`;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const lineWidth = measureText(line, t.fontSize, t.bold, t.italic, t.fontFamily);
      let xCanvas = t.x;
      if (t.boxWidth > 0) {
        if (t.align === "center") xCanvas = t.x + (t.boxWidth - lineWidth) / 2;
        else if (t.align === "right") xCanvas = t.x + t.boxWidth - lineWidth;
      } else if (t.align === "center") xCanvas = t.x - lineWidth / 2;
      else if (t.align === "right") xCanvas = t.x - lineWidth;
      const baselineCanvas = t.y + ascentPx + i * lineHeightPx;
      if (t.underline) {
        const yC = baselineCanvas + t.fontSize * 0.12;
        const yPdf = ctx.pageHeight - yC - thickness;
        out += `${fmt(xCanvas)} ${fmt(yPdf)} ${fmt(lineWidth)} ${fmt(thickness)} re f\n`;
      }
      if (t.strikethrough) {
        const yC = baselineCanvas - t.fontSize * 0.3;
        const yPdf = ctx.pageHeight - yC - thickness;
        out += `${fmt(xCanvas)} ${fmt(yPdf)} ${fmt(lineWidth)} ${fmt(thickness)} re f\n`;
      }
    }
  }

  out += "Q\n";
  return out;
}

// Suppress unused param warning for TextAlign (referenced via t.align).
const _alignSentinel: TextAlign = "left";
void _alignSentinel;

function emitShapeNode(ctx: BuildContext, node: PdfShapeNode): string {
  const s = node.layer;
  const hasGradFill = !!s.fillGradient && s.shapeType !== "line";
  const gradAlpha01 = hasGradFill
    ? (() => {
        const a = s.fillGradient!.stops[0]?.color.a ?? 1;
        return a > 1.0001 ? a / 255 : a;
      })()
    : 1;
  const solidFillA = s.fillColor
    ? alphaForPdf(s.fillColor) * node.layerOpacity
    : 0;
  const fillA = hasGradFill
    ? Math.max(0, Math.min(1, gradAlpha01)) * node.layerOpacity
    : solidFillA;
  const strokeA =
    s.strokeColor && s.strokeWidth > 0
      ? alphaForPdf(s.strokeColor) * node.layerOpacity
      : 0;
  if (fillA === 0 && strokeA === 0) return "";

  const gState = ensureGState(ctx, fillA, strokeA, node.blendMode);
  const hasSolidFill = !!s.fillColor && solidFillA > 0;
  const hasStroke = !!s.strokeColor && s.strokeWidth > 0 && strokeA > 0;

  let out = "q\n";
  out += `/${gState} gs\n`;

  // ── Gradient fill via clip + sh ─────────────────────────────────────────
  // Emit the shape's path in page space, clip to it (W n), then paint the
  // shading. The clipping path holds because Canvas2D-style coords are baked
  // at issuance time, so resetting the CTM doesn't move the clip region.
  if (hasGradFill) {
    out += "q\n";
    out += buildPathInPageSpace_shape(ctx, s);
    out += "W n\n";
    const shadingName = ensureShading(ctx, s.fillGradient!);
    out += `/${shadingName} sh\n`;
    out += "Q\n";

    // Stroke is emitted afterward in canvas-space too so the stroke aligns
    // with the gradient-clipped fill, not the local rotated frame.
    if (hasStroke && s.strokeColor) {
      const [r, g, b] = rgbForPdf(s.strokeColor);
      out += `${fmt(r)} ${fmt(g)} ${fmt(b)} RG\n`;
      out += `${fmt(s.strokeWidth)} w\n`;
      out += "1 j\n"; // round join (the local-frame path uses Canvas2D round)
      out += buildPathInPageSpace_shape(ctx, s);
      out += "S\n";
    }
    out += "Q\n";
    return out;
  }

  const paintOp = hasSolidFill && hasStroke ? "B" : hasSolidFill ? "f" : "S";

  if (hasSolidFill && s.fillColor) {
    const [r, g, b] = rgbForPdf(s.fillColor);
    out += `${fmt(r)} ${fmt(g)} ${fmt(b)} rg\n`;
  }
  if (hasStroke && s.strokeColor) {
    const [r, g, b] = rgbForPdf(s.strokeColor);
    out += `${fmt(r)} ${fmt(g)} ${fmt(b)} RG\n`;
    out += `${fmt(s.strokeWidth)} w\n`;
  }

  if (s.shapeType === "line") {
    const y1 = ctx.pageHeight - s.y1;
    const y2 = ctx.pageHeight - s.y2;
    out += `${fmt(s.x1)} ${fmt(y1)} m ${fmt(s.x2)} ${fmt(y2)} l S\n`;
    out += "Q\n";
    return out;
  }

  // For other shapes, set up local frame centred at (cx, cy) with rotation.
  const cxPdf = s.cx;
  const cyPdf = ctx.pageHeight - s.cy;
  out += `1 0 0 1 ${fmt(cxPdf)} ${fmt(cyPdf)} cm\n`;
  if (s.rotation) {
    const a = (-s.rotation * Math.PI) / 180; // canvas-CW = math-CW = -α in PDF Y-up
    const c = Math.cos(a);
    const si = Math.sin(a);
    out += `${fmt(c)} ${fmt(si)} ${fmt(-si)} ${fmt(c)} 0 0 cm\n`;
  }

  const hw = s.w / 2;
  const hh = s.h / 2;

  if (s.shapeType === "rectangle") {
    const r = Math.max(0, Math.min(s.cornerRadius, Math.min(hw, hh)));
    if (r <= 0) {
      out += `${fmt(-hw)} ${fmt(-hh)} ${fmt(s.w)} ${fmt(s.h)} re ${paintOp}\n`;
    } else {
      // Rounded rectangle via 4 cubic-Bezier corners. PDF Y-up local frame.
      const k = 0.5522847498307936; // (4/3) * tan(π/8)
      const kr = k * r;
      const x0 = -hw,
        x1 = hw,
        y0 = -hh,
        y1 = hh;
      out += `${fmt(x0 + r)} ${fmt(y0)} m\n`;
      out += `${fmt(x1 - r)} ${fmt(y0)} l\n`;
      out += `${fmt(x1 - r + kr)} ${fmt(y0)} ${fmt(x1)} ${fmt(y0 + r - kr)} ${fmt(x1)} ${fmt(y0 + r)} c\n`;
      out += `${fmt(x1)} ${fmt(y1 - r)} l\n`;
      out += `${fmt(x1)} ${fmt(y1 - r + kr)} ${fmt(x1 - r + kr)} ${fmt(y1)} ${fmt(x1 - r)} ${fmt(y1)} c\n`;
      out += `${fmt(x0 + r)} ${fmt(y1)} l\n`;
      out += `${fmt(x0 + r - kr)} ${fmt(y1)} ${fmt(x0)} ${fmt(y1 - r + kr)} ${fmt(x0)} ${fmt(y1 - r)} c\n`;
      out += `${fmt(x0)} ${fmt(y0 + r)} l\n`;
      out += `${fmt(x0)} ${fmt(y0 + r - kr)} ${fmt(x0 + r - kr)} ${fmt(y0)} ${fmt(x0 + r)} ${fmt(y0)} c\n`;
      out += `h ${paintOp}\n`;
    }
  } else if (s.shapeType === "ellipse") {
    const k = 0.5522847498307936;
    const kx = k * hw;
    const ky = k * hh;
    out += `${fmt(hw)} 0 m\n`;
    out += `${fmt(hw)} ${fmt(ky)} ${fmt(kx)} ${fmt(hh)} 0 ${fmt(hh)} c\n`;
    out += `${fmt(-kx)} ${fmt(hh)} ${fmt(-hw)} ${fmt(ky)} ${fmt(-hw)} 0 c\n`;
    out += `${fmt(-hw)} ${fmt(-ky)} ${fmt(-kx)} ${fmt(-hh)} 0 ${fmt(-hh)} c\n`;
    out += `${fmt(kx)} ${fmt(-hh)} ${fmt(hw)} ${fmt(-ky)} ${fmt(hw)} 0 c\n`;
    out += `h ${paintOp}\n`;
  } else if (s.shapeType === "triangle") {
    // Top vertex at canvas (0,-h/2) → local PDF (0, +h/2).
    out += `0 ${fmt(hh)} m\n`;
    out += `${fmt(hw)} ${fmt(-hh)} l\n`;
    out += `${fmt(-hw)} ${fmt(-hh)} l\n`;
    out += `h ${paintOp}\n`;
  } else if (s.shapeType === "diamond") {
    out += `0 ${fmt(hh)} m\n`;
    out += `${fmt(hw)} 0 l\n`;
    out += `0 ${fmt(-hh)} l\n`;
    out += `${fmt(-hw)} 0 l\n`;
    out += `h ${paintOp}\n`;
  } else if (s.shapeType === "star") {
    const points = 5;
    const innerRatio = 0.5;
    // Canvas: first point at top → local PDF top is +y.
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? 1 : innerRatio;
      const angle = -Math.PI / 2 + (i * Math.PI) / points;
      const px = Math.cos(angle) * r * hw;
      const py = -Math.sin(angle) * r * hh; // flip so first vertex is at +y (top)
      out += `${fmt(px)} ${fmt(py)} ${i === 0 ? "m" : "l"}\n`;
    }
    out += `h ${paintOp}\n`;
  }

  out += "Q\n";
  return out;
}

function emitPathNode(ctx: BuildContext, node: PdfPathNode): string {
  const p = node.layer;
  if (p.nodes.length < 2) return "";
  const hasGradFill = !!p.fillGradient && p.closed;
  const gradAlpha01 = hasGradFill
    ? (() => {
        const a = p.fillGradient!.stops[0]?.color.a ?? 1;
        return a > 1.0001 ? a / 255 : a;
      })()
    : 1;
  const solidFillA = p.fillColor
    ? alphaForPdf(p.fillColor) * node.layerOpacity
    : 0;
  const fillA = hasGradFill
    ? Math.max(0, Math.min(1, gradAlpha01)) * node.layerOpacity
    : solidFillA;
  const strokeA =
    p.strokeColor && p.strokeWidth > 0
      ? alphaForPdf(p.strokeColor) * node.layerOpacity
      : 0;
  if (fillA === 0 && strokeA === 0) return "";

  const hasFill = !hasGradFill && !!p.fillColor && solidFillA > 0 && p.closed;
  const hasStroke = !!p.strokeColor && p.strokeWidth > 0 && strokeA > 0;
  // PDF paint operators:
  //   B   = fill (nonzero) + stroke,  B* = fill (evenodd) + stroke
  //   f   = fill (nonzero),           f* = fill (evenodd)
  //   S   = stroke only
  //   n   = no-op (closes the path without painting)
  const evenOdd = p.fillRule === "evenodd";
  const paintOp = hasFill && hasStroke
    ? evenOdd ? "B*" : "B"
    : hasFill
      ? evenOdd ? "f*" : "f"
      : hasStroke
        ? "S"
        : "n";

  const gState = ensureGState(ctx, fillA, strokeA, node.blendMode);

  // PDF line-join: 0=miter, 1=round, 2=bevel.  Line-cap: 0=butt, 1=round, 2=square.
  const joinCode =
    p.strokeJoin === "miter" ? 0 : p.strokeJoin === "round" ? 1 : 2;
  const capCode =
    p.strokeCap === "butt" ? 0 : p.strokeCap === "round" ? 1 : 2;

  let out = "q\n";
  out += `/${gState} gs\n`;
  if (hasFill && p.fillColor) {
    const [r, g, b] = rgbForPdf(p.fillColor);
    out += `${fmt(r)} ${fmt(g)} ${fmt(b)} rg\n`;
  }
  if (hasStroke && p.strokeColor) {
    const [r, g, b] = rgbForPdf(p.strokeColor);
    out += `${fmt(r)} ${fmt(g)} ${fmt(b)} RG\n`;
    out += `${fmt(p.strokeWidth)} w\n`;
    out += `${joinCode} j\n`;
    out += `${capCode} J\n`;
    if (p.strokeJoin === "miter") {
      out += `${fmt(Math.max(1, p.miterLimit))} M\n`;
    }
    if (p.strokeDash.length > 0) {
      const dashArr = p.strokeDash.map(fmt).join(" ");
      out += `[${dashArr}] 0 d\n`;
    }
  }

  // Emit the path. Each canvas-space point is flipped to PDF Y-up by
  // y_pdf = pageHeight - y_canvas.
  const flipY = (y: number): number => ctx.pageHeight - y;
  const first = p.nodes[0];
  out += `${fmt(first.x)} ${fmt(flipY(first.y))} m\n`;
  const last = p.closed ? p.nodes.length : p.nodes.length - 1;
  for (let i = 0; i < last; i++) {
    const a = p.nodes[i];
    const b = p.nodes[(i + 1) % p.nodes.length];
    out += `${fmt(a.x + a.outX)} ${fmt(flipY(a.y + a.outY))} `;
    out += `${fmt(b.x + b.inX)} ${fmt(flipY(b.y + b.inY))} `;
    out += `${fmt(b.x)} ${fmt(flipY(b.y))} c\n`;
  }
  if (p.closed) out += "h ";
  out += `${paintOp}\n`;
  out += "Q\n";
  return out;
}

function emitImageRef(
  ctx: BuildContext,
  node: PdfImageNode,
  imageIndex: number,
): string {
  const name = `Im${imageIndex + 1}`;
  ctx.imageNames[imageIndex] = name;
  const gState = ensureGState(
    ctx,
    node.layerOpacity,
    node.layerOpacity,
    node.blendMode,
  );
  // Image XObjects render in their own 1×1 unit square, origin at bottom-left,
  // Y-up. We want the first scanline (top of image) at canvas-Y = node.y.
  // cm = w 0 0 h x (pageHeight - y - h) achieves that.
  const xPdf = node.x;
  const yPdf = ctx.pageHeight - node.y - node.height;
  let out = "q\n";
  out += `/${gState} gs\n`;
  out += `${fmt(node.width)} 0 0 ${fmt(node.height)} ${fmt(xPdf)} ${fmt(yPdf)} cm\n`;
  out += `/${name} Do\n`;
  out += "Q\n";
  return out;
}

// ─── Top-level builder ────────────────────────────────────────────────────────

export async function exportPdf(input: PdfExportInput): Promise<Uint8Array> {
  const { width, height, nodes } = input;

  const ctx: BuildContext = {
    pageHeight: height,
    fontIds: new Map(),
    gStateIds: new Map(),
    imageNames: [],
    shadings: [],
  };

  // First pass: build the content stream and collect referenced resources.
  let content = `q\n1 0 0 1 0 0 cm\n`;
  const imageNodes: PdfImageNode[] = [];
  for (const n of nodes) {
    if (n.kind === "text") {
      content += emitTextNode(ctx, n);
    } else if (n.kind === "shape") {
      content += emitShapeNode(ctx, n);
    } else if (n.kind === "path") {
      content += emitPathNode(ctx, n);
    } else {
      const idx = imageNodes.length;
      imageNodes.push(n);
      content += emitImageRef(ctx, n, idx);
    }
  }
  content += "Q\n";

  // Compress per-image RGB + SMask payloads.
  const imageStreams: {
    rgb: Uint8Array;
    alpha: Uint8Array;
    width: number;
    height: number;
  }[] = [];
  for (const n of imageNodes) {
    const px = n.pixels;
    const npx = n.width * n.height;
    const rgb = new Uint8Array(npx * 3);
    const alpha = new Uint8Array(npx);
    for (let i = 0; i < npx; i++) {
      rgb[i * 3] = px[i * 4];
      rgb[i * 3 + 1] = px[i * 4 + 1];
      rgb[i * 3 + 2] = px[i * 4 + 2];
      alpha[i] = px[i * 4 + 3];
    }
    const [rgbZ, aZ] = await Promise.all([deflate(rgb), deflate(alpha)]);
    imageStreams.push({ rgb: rgbZ, alpha: aZ, width: n.width, height: n.height });
  }

  // Compress the content stream too.
  const contentBytes = new TextEncoder().encode(content);
  const contentZ = await deflate(contentBytes);

  // ─── Assemble PDF objects ─────────────────────────────────────────────────
  //
  // Object layout:
  //   1: Catalog
  //   2: Pages
  //   3: Page
  //   4: Content stream
  //   5..: Font objects (one per unique base font)
  //   N..: ExtGState objects (one per opacity tuple)
  //   M..: Image XObjects (each image uses 2 objects: image + SMask)
  //
  const fontEntries = Array.from(ctx.fontIds.entries()); // [name, id]
  const gStateEntries = Array.from(ctx.gStateIds.entries()); // [key, id]

  const objects: Uint8Array[] = [];
  const pushObj = (s: string | Uint8Array): number => {
    const idx = objects.length + 1;
    if (typeof s === "string") objects.push(new TextEncoder().encode(s));
    else objects.push(s);
    return idx;
  };

  // Reserve object numbers for Catalog/Pages/Page/Content in fixed slots.
  const CATALOG_ID = 1;
  const PAGES_ID = 2;
  const PAGE_ID = 3;
  const CONTENT_ID = 4;
  // Placeholders so indices line up:
  objects.push(new Uint8Array(0)); // 1
  objects.push(new Uint8Array(0)); // 2
  objects.push(new Uint8Array(0)); // 3
  objects.push(new Uint8Array(0)); // 4

  // ICC profile stream (optional). When present, every downstream image XObject
  // and the page-level DefaultRGB colour space refer to this object.
  let iccObjId = 0;
  if (input.iccProfile && input.iccProfile.length > 0) {
    const iccZ = await deflate(input.iccProfile);
    const iccHeader =
      `<< /N 3 /Alternate /DeviceRGB /Filter /FlateDecode /Length ${iccZ.length} >>`;
    iccObjId = pushObjWithStream(objects, iccHeader, iccZ);
  }

  // Font objects
  const fontObjIds: Record<string, number> = {};
  for (const [baseName, resId] of fontEntries) {
    const objStr =
      `<< /Type /Font /Subtype /Type1 /BaseFont /${baseName} /Encoding /WinAnsiEncoding >>`;
    fontObjIds[resId] = pushObj(`${objects.length + 1} 0 obj\n${objStr}\nendobj\n`);
  }

  // ExtGState objects
  const gStateObjIds: Record<string, number> = {};
  for (const [key, resId] of gStateEntries) {
    const parts = key.split(":");
    const fa = Number(parts[0]);
    const sa = Number(parts[1]);
    const bm = parts[2] ?? "Normal";
    const objStr = `<< /Type /ExtGState /ca ${fmt(fa)} /CA ${fmt(sa)} /BM /${bm} >>`;
    gStateObjIds[resId] = pushObj(`${objects.length + 1} 0 obj\n${objStr}\nendobj\n`);
  }

  // Image XObjects (each image: an SMask object first, then the main image
  // referring to it via /SMask).
  const imageObjIds: number[] = [];
  for (let i = 0; i < imageStreams.length; i++) {
    const im = imageStreams[i];
    // SMask
    const smaskHeader =
      `<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} ` +
      `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${im.alpha.length} >>`;
    const smaskId = pushObjWithStream(objects, smaskHeader, im.alpha);
    // Main image
    const colorSpaceRef =
      iccObjId > 0 ? `[/ICCBased ${iccObjId} 0 R]` : "/DeviceRGB";
    const imgHeader =
      `<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} ` +
      `/ColorSpace ${colorSpaceRef} /BitsPerComponent 8 /SMask ${smaskId} 0 R ` +
      `/Filter /FlateDecode /Length ${im.rgb.length} >>`;
    const imgId = pushObjWithStream(objects, imgHeader, im.rgb);
    imageObjIds.push(imgId);
  }

  // Now backfill 1..4.
  const fontDict =
    fontEntries.length === 0
      ? ""
      : "/Font << " +
        fontEntries
          .map(([, resId]) => `/${resId} ${fontObjIds[resId]} 0 R`)
          .join(" ") +
        " >> ";
  const gStateDict =
    gStateEntries.length === 0
      ? ""
      : "/ExtGState << " +
        gStateEntries
          .map(([, resId]) => `/${resId} ${gStateObjIds[resId]} 0 R`)
          .join(" ") +
        " >> ";
  const xobjectDict =
    imageObjIds.length === 0
      ? ""
      : "/XObject << " +
        imageObjIds
          .map((id, i) => `/${ctx.imageNames[i]} ${id} 0 R`)
          .join(" ") +
        " >> ";
  // When an ICC profile is embedded, set it as DefaultRGB so the `rg`/`RG`
  // colour operators used by text and shape fills/strokes are colour-managed
  // by viewers (Acrobat, Preview, etc.).
  const colorSpaceDict =
    iccObjId > 0
      ? `/ColorSpace << /DefaultRGB [/ICCBased ${iccObjId} 0 R] >> `
      : "";
  const resources = `<< ${fontDict}${gStateDict}${xobjectDict}${colorSpaceDict}/ProcSet [/PDF /Text /ImageC /ImageB] >>`;

  objects[0] = new TextEncoder().encode(
    `${CATALOG_ID} 0 obj\n<< /Type /Catalog /Pages ${PAGES_ID} 0 R >>\nendobj\n`,
  );
  objects[1] = new TextEncoder().encode(
    `${PAGES_ID} 0 obj\n<< /Type /Pages /Kids [${PAGE_ID} 0 R] /Count 1 >>\nendobj\n`,
  );
  objects[2] = new TextEncoder().encode(
    `${PAGE_ID} 0 obj\n<< /Type /Page /Parent ${PAGES_ID} 0 R /MediaBox [0 0 ${fmt(width)} ${fmt(height)}] /Resources ${resources} /Contents ${CONTENT_ID} 0 R >>\nendobj\n`,
  );
  objects[3] = concatBytes([
    new TextEncoder().encode(
      `${CONTENT_ID} 0 obj\n<< /Filter /FlateDecode /Length ${contentZ.length} >>\nstream\n`,
    ),
    contentZ,
    new TextEncoder().encode("\nendstream\nendobj\n"),
  ]);

  // ─── Assemble final bytes with xref + trailer ─────────────────────────────
  const header = new TextEncoder().encode("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n");
  const parts: Uint8Array[] = [header];
  const offsets: number[] = []; // offset of obj N is offsets[N-1]
  let pos = header.length;
  for (const obj of objects) {
    offsets.push(pos);
    parts.push(obj);
    pos += obj.length;
  }
  const xrefOffset = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${off.toString().padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${CATALOG_ID} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(new TextEncoder().encode(xref));

  return concatBytes(parts);
}

// ─── Small byte helpers ───────────────────────────────────────────────────────

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function pushObjWithStream(
  objects: Uint8Array[],
  header: string,
  data: Uint8Array,
): number {
  const id = objects.length + 1;
  const head = new TextEncoder().encode(`${id} 0 obj\n${header}\nstream\n`);
  const tail = new TextEncoder().encode("\nendstream\nendobj\n");
  objects.push(concatBytes([head, data, tail]));
  return id;
}
