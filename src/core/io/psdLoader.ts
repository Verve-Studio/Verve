import { readPsd, type Psd, type Layer, type BlendMode, type Color as PsdColor } from "ag-psd";
import type {
  BlendMode as VerveBlendMode,
  RGBAColor,
  TextAlign,
  TextAntiAlias,
  TextLayerState,
  TextLigatures,
} from "@/types";
import { extractIccFromPsd } from "@/core/cms/iccProfile";

// ─── Imported PSD layer (intermediate shape) ──────────────────────────────────

export interface PsdImportedLayer {
  kind: "layer";
  /** Stable id assigned at import time. */
  id: string;
  name: string;
  visible: boolean;
  opacity: number; // 0..1
  blendMode: VerveBlendMode;
  /** Layer-local pixel buffer, RGBA bytes, top-row-first. */
  pixels: Uint8Array;
  layerWidth: number;
  layerHeight: number;
  /** Top-left offset of the layer relative to the canvas. */
  offsetX: number;
  offsetY: number;
  /** Optional layer mask (single-channel, top-row-first). When present, it's
   *  positioned at (maskOffsetX, maskOffsetY) with size (maskWidth, maskHeight). */
  mask?: {
    pixels: Uint8Array;
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
    /** PSD's default fill colour outside the mask rect (0 = hide, 255 = reveal). */
    defaultColor: number;
  };
}

export interface PsdImportedGroup {
  kind: "group";
  id: string;
  name: string;
  visible: boolean;
  collapsed: boolean;
  /** Children in **bottom-first** z-order (matching our `state.layers`
   *  convention). */
  children: PsdImportedNode[];
}

/**
 * Live (non-rasterised) text layer imported from a PSD. Carries the full
 * PSD character/paragraph attribute set so the renderer can re-rasterise
 * with the same fidelity Photoshop would. Anything we can't represent
 * (style runs — per-character variation — and ag-psd's read-only text path)
 * is intentionally dropped here; the rest of the per-character defaults are
 * taken from `text.style` and the per-paragraph defaults from
 * `text.paragraphStyle`.
 */
export interface PsdImportedText {
  kind: "text";
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: VerveBlendMode;
  /** Fields mirror `TextLayerState`'s PSD-compatible set; the consumer
   *  builds a `TextLayerState` from these. */
  text: Omit<
    TextLayerState,
    "id" | "name" | "visible" | "opacity" | "locked" | "blendMode" | "type"
  >;
}

export type PsdImportedNode =
  | PsdImportedLayer
  | PsdImportedGroup
  | PsdImportedText;

export interface PsdImportResult {
  width: number;
  height: number;
  /** Top-level nodes in **bottom-first** z-order. Groups preserve PSD folder
   *  structure recursively. Skips adjustments, text, shape, smart objects. */
  nodes: PsdImportedNode[];
  /** True if any unsupported layer types were encountered and skipped. */
  hadUnsupportedLayers: boolean;
  /** Document-level ICC profile (Image Resource ID 1039), preserved verbatim
   *  for round-trip. `undefined` if the PSD has no embedded profile. */
  iccProfile?: Uint8Array;
}

// ─── Blend-mode mapping ───────────────────────────────────────────────────────

/** Map PSD blend modes to our supported set. Anything unmapped falls back to
 *  "normal" — we explicitly accept this lossiness for PSD interop. */
function blendModeFromPsd(mode: BlendMode | undefined): VerveBlendMode {
  switch (mode) {
    case "normal":
    case "pass through": // groups; we flatten so this maps to normal
      return "normal";
    case "multiply":
      return "multiply";
    case "screen":
      return "screen";
    case "overlay":
      return "overlay";
    case "soft light":
      return "soft-light";
    case "hard light":
      return "hard-light";
    case "darken":
      return "darken";
    case "lighten":
      return "lighten";
    case "difference":
      return "difference";
    case "exclusion":
      return "exclusion";
    case "color dodge":
      return "color-dodge";
    case "color burn":
      return "color-burn";
    default:
      return "normal";
  }
}

// ─── PSD text-layer mapping ───────────────────────────────────────────────────

/** PSD colour → our float RGBA. PSD can carry colour in many spaces; this
 *  normalises to the float convention used everywhere else in the app
 *  (r/g/b in [0, ∞), a in [0, 1]) so HDR values round-trip through 32-bit
 *  PSDs without precision loss. */
function psdColorToRgba(c: PsdColor | undefined): RGBAColor | null {
  if (!c) return null;
  // RGBA — values are 0–255 ints (or 16-bit values that ag-psd has already
  // down-converted into the same 0–255 range).
  if ("r" in c && "g" in c && "b" in c) {
    const r = (c as { r: number }).r ?? 0;
    const g = (c as { g: number }).g ?? 0;
    const b = (c as { b: number }).b ?? 0;
    const a =
      "a" in c && typeof (c as { a: unknown }).a === "number"
        ? (c as { a: number }).a
        : 255;
    return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
  }
  // FRGB (0..1+ floats) — pass through verbatim, including HDR.
  if ("fr" in c) {
    const fc = c as { fr: number; fg: number; fb: number };
    return { r: fc.fr ?? 0, g: fc.fg ?? 0, b: fc.fb ?? 0, a: 1 };
  }
  // Grayscale (0–255).
  if ("k" in c && !("c" in c)) {
    const k = ((c as { k: number }).k ?? 0) / 255;
    return { r: k, g: k, b: k, a: 1 };
  }
  // CMYK / LAB / HSB — best-effort fall-through to white. PSD text fills
  // are overwhelmingly RGB / FRGB in practice; the exotic spaces are rare
  // enough that we accept the lossiness rather than carry a full CMS here.
  return { r: 1, g: 1, b: 1, a: 1 };
}

function psdJustificationToAlign(j: string | undefined): TextAlign {
  switch (j) {
    case "left":
      return "left";
    case "right":
      return "right";
    case "center":
      return "center";
    case "justify-left":
    case "justify-right":
    case "justify-center":
    case "justify-all":
      return "justify";
    default:
      return "left";
  }
}

function psdAntiAliasToVerve(
  v: NonNullable<Layer["text"]>["antiAlias"],
): TextAntiAlias {
  switch (v) {
    case "none":
      return "none";
    case "sharp":
      return "sharp";
    case "crisp":
      return "crisp";
    case "strong":
      return "strong";
    case "smooth":
    case "platform":
    case "platformLCD":
    default:
      return "smooth";
  }
}

/** Build a TextLayerState-shaped object from ag-psd's `LayerTextData`. */
function buildPsdTextFields(t: NonNullable<Layer["text"]>): PsdImportedText["text"] {
  const charStyle = t.style ?? {};
  const paraStyle = t.paragraphStyle ?? {};

  // PSD's text.transform = [a, b, c, d, tx, ty]; we use tx/ty as the layer
  // origin. The non-translation components (scale/rotation) are folded into
  // horizontal/verticalScale below — full affine isn't expressible on our
  // TextLayerState, but the common identity-rotation case round-trips.
  const tx = t.transform?.[4] ?? 0;
  const ty = t.transform?.[5] ?? 0;
  const a = t.transform?.[0] ?? 1;
  const d = t.transform?.[3] ?? 1;

  const fontSize = (charStyle.fontSize ?? 12) * Math.abs(a);
  // PSD tracking is in milliems (1/1000 em); convert to canvas px.
  const tracking = charStyle.tracking ?? 0;
  const letterSpacing = (tracking / 1000) * fontSize;

  // fontCaps: 0 = normal, 1 = smallCaps, 2 = allCaps.
  const allCaps = charStyle.fontCaps === 2;
  const smallCaps = charStyle.fontCaps === 1;
  // fontBaseline: 0 = normal, 1 = super, 2 = sub.
  const superscript = charStyle.fontBaseline === 1;
  const subscript = charStyle.fontBaseline === 2;

  // Ligature combination.
  let ligatures: TextLigatures = "standard";
  if (charStyle.ligatures === false && charStyle.dLigatures !== true)
    ligatures = "none";
  else if (charStyle.dLigatures === true) ligatures = "all";

  // Box bounds — for area text, PSD ships [left, top, right, bottom].
  const isBox = t.shapeType === "box";
  let boxWidth = 0;
  let boxHeight = 0;
  if (isBox && t.boxBounds && t.boxBounds.length >= 4) {
    boxWidth = Math.max(0, t.boxBounds[2] - t.boxBounds[0]);
    boxHeight = Math.max(0, t.boxBounds[3] - t.boxBounds[1]);
  }

  const fill = psdColorToRgba(charStyle.fillColor);
  const stroke =
    charStyle.strokeFlag !== false
      ? psdColorToRgba(charStyle.strokeColor)
      : null;

  return {
    text: t.text,
    x: Math.round(tx),
    y: Math.round(ty),
    boxWidth: Math.round(boxWidth),
    boxHeight: Math.round(boxHeight),
    fontFamily: charStyle.font?.name ?? "Arial",
    fontSize,
    bold: false, // PSD encodes weight inside font.name; faux* covers synthetic
    italic: false,
    underline: charStyle.underline ?? false,
    strikethrough: charStyle.strikethrough ?? false,
    align: psdJustificationToAlign(paraStyle.justification),
    letterSpacing,
    lineHeight:
      !charStyle.autoLeading && charStyle.leading && fontSize > 0
        ? charStyle.leading / fontSize
        : 1.2,
    kerning: charStyle.autoKerning === false ? "none" : "auto",
    color: fill ?? { r: 1, g: 1, b: 1, a: 1 },

    horizontalScale: (charStyle.horizontalScale ?? 1) * 100,
    verticalScale: (charStyle.verticalScale ?? 1) * 100 * Math.abs(d / a),
    baselineShift: charStyle.baselineShift ?? 0,
    fauxBold: charStyle.fauxBold ?? false,
    fauxItalic: charStyle.fauxItalic ?? false,
    allCaps,
    smallCaps,
    superscript,
    subscript,
    antiAlias: psdAntiAliasToVerve(t.antiAlias),
    strokeColor: stroke,
    strokeWidth: charStyle.outlineWidth ?? 0,
    ligatures,

    firstLineIndent: paraStyle.firstLineIndent ?? 0,
    leftIndent: paraStyle.startIndent ?? 0,
    rightIndent: paraStyle.endIndent ?? 0,
    spaceBefore: paraStyle.spaceBefore ?? 0,
    spaceAfter: paraStyle.spaceAfter ?? 0,
    hyphenate: paraStyle.autoHyphenate ?? false,
    noBreak: charStyle.noBreak ?? false,
    direction: "ltr",
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Pull RGBA pixels out of a parsed PSD layer. ag-psd may have provided either
 *  a `canvas` (HTMLCanvasElement) or `imageData` (PixelData). Either way, we
 *  return a fresh layer-local Uint8Array of RGBA bytes. */
function readLayerRgba(layer: Layer): {
  pixels: Uint8Array;
  width: number;
  height: number;
} | null {
  const w =
    (layer.right ?? 0) - (layer.left ?? 0) || layer.canvas?.width || layer.imageData?.width || 0;
  const h =
    (layer.bottom ?? 0) - (layer.top ?? 0) || layer.canvas?.height || layer.imageData?.height || 0;
  if (w <= 0 || h <= 0) return null;
  if (layer.imageData) {
    const src = layer.imageData.data as Uint8Array | Uint8ClampedArray;
    return {
      pixels: new Uint8Array(src.buffer, src.byteOffset, src.byteLength).slice(),
      width: layer.imageData.width,
      height: layer.imageData.height,
    };
  }
  if (layer.canvas) {
    const ctx2d = layer.canvas.getContext("2d");
    if (!ctx2d) return null;
    const id = ctx2d.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
    return {
      pixels: new Uint8Array(id.data.buffer).slice(),
      width: layer.canvas.width,
      height: layer.canvas.height,
    };
  }
  return null;
}

/** Pull the single-channel mask (R) from a PSD mask record. ag-psd stores mask
 *  pixel data in RGBA where R is the mask alpha (0..255). */
function readMaskAlpha(
  mask: NonNullable<Layer["mask"]>,
): { pixels: Uint8Array; width: number; height: number } | null {
  let rgba: Uint8Array | Uint8ClampedArray | null = null;
  let mw = 0;
  let mh = 0;
  if (mask.imageData) {
    rgba = mask.imageData.data as Uint8Array | Uint8ClampedArray;
    mw = mask.imageData.width;
    mh = mask.imageData.height;
  } else if (mask.canvas) {
    const ctx2d = mask.canvas.getContext("2d");
    if (!ctx2d) return null;
    const id = ctx2d.getImageData(0, 0, mask.canvas.width, mask.canvas.height);
    rgba = id.data;
    mw = mask.canvas.width;
    mh = mask.canvas.height;
  }
  if (!rgba || mw <= 0 || mh <= 0) return null;
  // Extract R channel (alpha-as-mask convention).
  const out = new Uint8Array(mw * mh);
  for (let i = 0; i < mw * mh; i++) out[i] = rgba[i * 4];
  return { pixels: out, width: mw, height: mh };
}

/** Recursively walk PSD's layer tree, preserving folder structure as
 *  PsdImportedGroup nodes and emitting image-bearing leaves as
 *  PsdImportedLayer. Adjustments / text / shapes / smart objects are
 *  skipped (and flagged via state.hadUnsupported). ag-psd's `children` is
 *  already in **bottom-first** z-order (PSD files store layers bottom-up,
 *  and ag-psd preserves that), which matches `state.layers`, so no
 *  reversal is needed. */
function walkLayers(
  layers: Layer[] | undefined,
  state: { idCounter: number; hadUnsupported: boolean },
): PsdImportedNode[] {
  if (!layers) return [];
  const out: PsdImportedNode[] = [];
  for (const layer of layers) {
    // Group (has children) — recurse, preserving folder structure.
    if (layer.children && layer.children.length > 0) {
      const children = walkLayers(layer.children, state);
      out.push({
        kind: "group",
        id: `psd-g-${state.idCounter++}`,
        name: layer.name ?? `Group ${state.idCounter}`,
        visible: layer.hidden !== true,
        collapsed: layer.opened === false,
        children,
      });
      continue;
    }
    // Live text layer — ag-psd parses the engine-data record into `layer.text`
    // (LayerTextData). Round-trip these as PsdImportedText so we keep the
    // full PSD character/paragraph attribute set, rather than rasterising
    // the type into a flat pixel layer.
    if ("text" in layer && layer.text) {
      out.push({
        kind: "text",
        id: `psd-t-${state.idCounter++}`,
        name: layer.name ?? `Text ${state.idCounter}`,
        visible: layer.hidden !== true,
        opacity: typeof layer.opacity === "number" ? layer.opacity : 1,
        blendMode: blendModeFromPsd(layer.blendMode),
        text: buildPsdTextFields(layer.text),
      });
      continue;
    }
    // Adjustment layer / smart object / etc. — out of scope.
    const hasImageOrCanvas = !!(layer.imageData || layer.canvas);
    const isPixelLeaf =
      hasImageOrCanvas &&
      !("adjustment" in layer && (layer as { adjustment?: unknown }).adjustment) &&
      !("placedLayer" in layer && (layer as { placedLayer?: unknown }).placedLayer);
    if (!isPixelLeaf) {
      if (!hasImageOrCanvas) {
        // No pixels at all — silently skip (empty marker layer).
        continue;
      }
      state.hadUnsupported = true;
      continue;
    }
    const rgba = readLayerRgba(layer);
    if (!rgba) continue;

    const id = `psd-${state.idCounter++}`;
    const left = layer.left ?? 0;
    const top = layer.top ?? 0;

    let mask: PsdImportedLayer["mask"] | undefined = undefined;
    if (layer.mask && !layer.mask.disabled) {
      const m = readMaskAlpha(layer.mask);
      if (m) {
        mask = {
          pixels: m.pixels,
          width: m.width,
          height: m.height,
          offsetX: layer.mask.left ?? 0,
          offsetY: layer.mask.top ?? 0,
          defaultColor: layer.mask.defaultColor ?? 0,
        };
      }
    }

    out.push({
      kind: "layer",
      id,
      name: layer.name ?? `Layer ${state.idCounter}`,
      visible: layer.hidden !== true,
      opacity: typeof layer.opacity === "number" ? layer.opacity : 1,
      blendMode: blendModeFromPsd(layer.blendMode),
      pixels: rgba.pixels,
      layerWidth: rgba.width,
      layerHeight: rgba.height,
      offsetX: left,
      offsetY: top,
      mask,
    });
  }
  return out;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Parse a PSD file's bytes into a list of pixel layers + canvas size. Skips
 *  any layer kind we don't support (text, shape, adjustments, smart objects,
 *  groups are flattened). */
export function loadPsdLayers(buffer: ArrayBuffer): PsdImportResult {
  const psd: Psd = readPsd(buffer, {
    skipCompositeImageData: true,
    skipThumbnail: true,
    useImageData: true,
  });
  const state = { idCounter: 0, hadUnsupported: false };
  const nodes = walkLayers(psd.children, state);
  // ag-psd doesn't surface Image Resource 1039 in its typed API, so parse
  // the resource block directly from the source bytes.
  const iccProfile = extractIccFromPsd(new Uint8Array(buffer)) ?? undefined;
  return {
    width: psd.width,
    height: psd.height,
    nodes,
    hadUnsupportedLayers: state.hadUnsupported,
    iccProfile,
  };
}
