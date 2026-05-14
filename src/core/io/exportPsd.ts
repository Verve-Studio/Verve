import {
  writePsdUint8Array,
  type Psd,
  type Layer,
  type BlendMode,
  type LayerTextData,
  type Justification,
  type AntiAlias as PsdAntiAlias,
} from "ag-psd";
import type {
  BlendMode as VerveBlendMode,
  TextAlign,
  TextAntiAlias,
  TextLayerState,
  TextLigatures,
  RGBAColor,
} from "@/types";

// ─── Input shape ──────────────────────────────────────────────────────────────

export interface PsdExportLayer {
  kind: "layer";
  name: string;
  visible: boolean;
  opacity: number; // 0..1
  blendMode: VerveBlendMode;
  /** Layer-local RGBA pixels (top-row-first). */
  pixels: Uint8Array;
  layerWidth: number;
  layerHeight: number;
  /** Layer top-left in canvas coords. */
  offsetX: number;
  offsetY: number;
  /** Optional layer mask. Single-channel R bytes (0 = hide, 255 = reveal),
   *  positioned at (maskOffsetX, maskOffsetY) with size (maskWidth, maskHeight).
   *  Coords are canvas-space; we'll pack into a PSD layer-mask record. */
  mask?: {
    pixels: Uint8Array;
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
  };
}

export interface PsdExportGroup {
  kind: "group";
  name: string;
  visible: boolean;
  opacity: number; // 0..1
  blendMode: VerveBlendMode;
  /** True = expanded in the Photoshop layers panel. */
  opened: boolean;
  /** Children in **bottom-first** z-order (same convention as the top-level
   *  layers array, and what ag-psd's `children` already uses). */
  children: PsdExportNode[];
}

/** Live (non-rasterised) text layer to be written into the PSD's text
 *  engine record. Photoshop can re-edit these natively; round-trips back
 *  into Verve via PsdImportedText. */
export interface PsdExportText {
  kind: "text";
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: VerveBlendMode;
  /** Same shape as the TextLayerState's PSD-compatible field set; supplied
   *  by the caller from a TextLayerState. */
  text: Omit<
    TextLayerState,
    "id" | "name" | "visible" | "opacity" | "locked" | "blendMode" | "type"
  >;
}

export type PsdExportNode = PsdExportLayer | PsdExportGroup | PsdExportText;

export interface PsdExportInput {
  width: number;
  height: number;
  /** Top-level nodes in **bottom-first** z-order (matches our `state.layers`
   *  order and ag-psd's `children` convention — emitted as-is). */
  layers: PsdExportNode[];
  /** Source document's colour depth. Controls *text-engine* colour encoding
   *  only — pixel data is always written as 8-bit (PSD pixel-channel writes
   *  haven't been ported to float yet). When 32, text fill / stroke colours
   *  are emitted as `FRGB` so HDR values survive a round-trip through
   *  Photoshop's text engine; when 8, colours are clamped to 0–255 `RGB`. */
  bitsPerChannel?: 8 | 32;
}

// ─── Blend-mode mapping ───────────────────────────────────────────────────────

function blendModeToPsd(mode: VerveBlendMode): BlendMode {
  switch (mode) {
    case "normal":
      return "normal";
    case "multiply":
      return "multiply";
    case "screen":
      return "screen";
    case "overlay":
      return "overlay";
    case "soft-light":
      return "soft light";
    case "hard-light":
      return "hard light";
    case "darken":
      return "darken";
    case "lighten":
      return "lighten";
    case "difference":
      return "difference";
    case "exclusion":
      return "exclusion";
    case "color-dodge":
      return "color dodge";
    case "color-burn":
      return "color burn";
    default:
      return "normal";
  }
}

// ─── Text-attribute mapping (TextLayerState → ag-psd) ────────────────────────

/**
 * Float RGBA → PSD colour, picking the encoding that preserves the most
 * information for the target bit depth:
 *  - 32-bit PSDs use `FRGB` so HDR (>1) values round-trip verbatim.
 *  - 8-bit PSDs use `RGB` 0–255 ints; HDR clips at 255 by design.
 */
function rgbaToPsdColor(
  c: RGBAColor,
  bitsPerChannel: 8 | 32,
):
  | { r: number; g: number; b: number }
  | { fr: number; fg: number; fb: number } {
  if (bitsPerChannel === 32) {
    return { fr: c.r, fg: c.g, fb: c.b };
  }
  const clamp = (v: number): number =>
    Math.max(0, Math.min(255, Math.round(v * 255)));
  return { r: clamp(c.r), g: clamp(c.g), b: clamp(c.b) };
}

function alignToJustification(a: TextAlign): Justification {
  switch (a) {
    case "left":
      return "left";
    case "right":
      return "right";
    case "center":
      return "center";
    case "justify":
      return "justify-left";
  }
}

function antiAliasToPsd(a: TextAntiAlias | undefined): PsdAntiAlias {
  switch (a) {
    case "none":
      return "none";
    case "sharp":
      return "sharp";
    case "crisp":
      return "crisp";
    case "strong":
      return "strong";
    case "smooth":
    default:
      return "smooth";
  }
}

function buildLayerTextData(
  t: PsdExportText["text"],
  bitsPerChannel: 8 | 32,
): LayerTextData {
  const fontSize = t.fontSize;
  // PSD tracking is milliems; reverse our (tracking/1000)*fontSize → tracking.
  const tracking =
    fontSize > 0 ? Math.round(((t.letterSpacing ?? 0) / fontSize) * 1000) : 0;
  const fontCaps = t.allCaps ? 2 : t.smallCaps ? 1 : 0;
  const fontBaseline = t.superscript ? 1 : t.subscript ? 2 : 0;
  const ligatures: TextLigatures = t.ligatures ?? "standard";
  const liga = ligatures !== "none";
  const dliga = ligatures === "all";

  const hasStroke = !!(t.strokeColor && (t.strokeWidth ?? 0) > 0);

  const style = {
    font: { name: t.fontFamily },
    fontSize,
    fauxBold: t.fauxBold ?? false,
    fauxItalic: t.fauxItalic ?? false,
    autoLeading: !t.lineHeight || t.lineHeight === 0,
    leading: (t.lineHeight ?? 1.2) * fontSize,
    horizontalScale: (t.horizontalScale ?? 100) / 100,
    verticalScale: (t.verticalScale ?? 100) / 100,
    tracking,
    autoKerning: (t.kerning ?? "auto") === "auto",
    baselineShift: t.baselineShift ?? 0,
    fontCaps,
    fontBaseline,
    underline: t.underline,
    strikethrough: t.strikethrough,
    ligatures: liga,
    dLigatures: dliga,
    noBreak: t.noBreak ?? false,
    fillColor: rgbaToPsdColor(t.color, bitsPerChannel),
    fillFlag: true,
    strokeColor:
      hasStroke && t.strokeColor
        ? rgbaToPsdColor(t.strokeColor, bitsPerChannel)
        : undefined,
    strokeFlag: hasStroke,
    outlineWidth: hasStroke ? (t.strokeWidth ?? 0) : 0,
  };

  const paragraphStyle = {
    justification: alignToJustification(t.align),
    firstLineIndent: t.firstLineIndent ?? 0,
    startIndent: t.leftIndent ?? 0,
    endIndent: t.rightIndent ?? 0,
    spaceBefore: t.spaceBefore ?? 0,
    spaceAfter: t.spaceAfter ?? 0,
    autoHyphenate: t.hyphenate ?? false,
  };

  const isBox = t.boxWidth > 0 && t.boxHeight > 0;
  // PSD's text.transform is an affine [a, b, c, d, tx, ty]; identity scale,
  // no rotation, position at (x, y). horizontal/verticalScale live in the
  // character style — we don't bake them into the transform.
  const transform = [1, 0, 0, 1, t.x, t.y];

  const textData: LayerTextData = {
    text: t.text,
    transform,
    antiAlias: antiAliasToPsd(t.antiAlias),
    orientation: "horizontal",
    style,
    styleRuns: [{ length: t.text.length, style }],
    paragraphStyle,
    paragraphStyleRuns: [
      { length: t.text.length, style: paragraphStyle },
    ],
    shapeType: isBox ? "box" : "point",
  };
  if (isBox) {
    textData.boxBounds = [0, 0, t.boxWidth, t.boxHeight];
  }
  return textData;
}

// ─── Build PSD ────────────────────────────────────────────────────────────────

/** Encode a list of pixel layers + canvas size as a PSD file (Uint8Array of
 *  PSD bytes). Only pixel data + per-layer mask + opacity + blendMode +
 *  visibility are written; everything else (groups, text, shapes, adjustments)
 *  must be excluded by the caller. */
function nodeToLayer(node: PsdExportNode, bitsPerChannel: 8 | 32): Layer {
  if (node.kind === "group") {
    const children: Layer[] = node.children.map((c) =>
      nodeToLayer(c, bitsPerChannel),
    );
    return {
      name: node.name,
      hidden: !node.visible,
      opacity: node.opacity,
      blendMode: blendModeToPsd(node.blendMode),
      opened: node.opened,
      children,
    };
  }
  if (node.kind === "text") {
    // Live text layer. We leave `imageData` empty — Photoshop renders from
    // the engine-data record. (Setting `invalidateTextLayers: true` on the
    // writer asks PS to re-rasterise on next open, which is safer than
    // shipping a pre-rendered bitmap that may diverge from the text data.)
    return {
      name: node.name,
      hidden: !node.visible,
      opacity: node.opacity,
      blendMode: blendModeToPsd(node.blendMode),
      // Bounding box: derived from the text origin + (boxWidth/Height for
      // area text). For point text we leave the bounds collapsed at the
      // origin — Photoshop expands them on re-rasterise.
      left: Math.round(node.text.x),
      top: Math.round(node.text.y),
      right: Math.round(
        node.text.x + (node.text.boxWidth > 0 ? node.text.boxWidth : 0),
      ),
      bottom: Math.round(
        node.text.y + (node.text.boxHeight > 0 ? node.text.boxHeight : 0),
      ),
      text: buildLayerTextData(node.text, bitsPerChannel),
    };
  }
  const layer: Layer = {
    name: node.name,
    hidden: !node.visible,
    opacity: node.opacity,
    blendMode: blendModeToPsd(node.blendMode),
    left: node.offsetX,
    top: node.offsetY,
    right: node.offsetX + node.layerWidth,
    bottom: node.offsetY + node.layerHeight,
    imageData: {
      width: node.layerWidth,
      height: node.layerHeight,
      data: node.pixels,
    },
  };
  if (node.mask) {
    const mw = node.mask.width;
    const mh = node.mask.height;
    // PSD masks use RGBA shape with R as the mask channel. Expand single-
    // channel input → packed RGBA.
    const maskRgba = new Uint8Array(mw * mh * 4);
    for (let p = 0; p < mw * mh; p++) {
      const v = node.mask.pixels[p];
      const j = p * 4;
      maskRgba[j] = v;
      maskRgba[j + 1] = v;
      maskRgba[j + 2] = v;
      maskRgba[j + 3] = 255;
    }
    layer.mask = {
      left: node.mask.offsetX,
      top: node.mask.offsetY,
      right: node.mask.offsetX + mw,
      bottom: node.mask.offsetY + mh,
      defaultColor: 0,
      imageData: { width: mw, height: mh, data: maskRgba },
    };
  }
  return layer;
}

export function exportPsd(input: PsdExportInput): Uint8Array {
  // `bitsPerChannel` controls text-engine colour encoding (see PsdExportInput
  // docs). The PSD container itself stays at 8 — pixel data is 8-bit
  // Uint8Array throughout this writer.
  const textColorBits: 8 | 32 = input.bitsPerChannel ?? 8;
  const layers: Layer[] = input.layers.map((n) =>
    nodeToLayer(n, textColorBits),
  );

  const psd: Psd = {
    width: input.width,
    height: input.height,
    channels: 4,
    bitsPerChannel: 8,
    colorMode: 3, // RGB
    children: layers,
  };

  return writePsdUint8Array(psd, {
    generateThumbnail: false,
    // Keep our text-engine record intact so Photoshop opens the live text
    // layer as editable type. The previous `true` here asked PS to discard
    // the engine data and re-rasterise on open, which lost all the
    // character/paragraph attributes we just wrote out.
    invalidateTextLayers: false,
    psb: false,
  });
}
