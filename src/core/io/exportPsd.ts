import { writePsdUint8Array, type Psd, type Layer, type BlendMode } from "ag-psd";
import type { BlendMode as VerveBlendMode } from "@/types";

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
   *  layers array). exportPsd reverses to top-first when emitting. */
  children: PsdExportNode[];
}

export type PsdExportNode = PsdExportLayer | PsdExportGroup;

export interface PsdExportInput {
  width: number;
  height: number;
  /** Top-level nodes in **bottom-first** z-order (matches our `state.layers`
   *  order). exportPsd emits them top-first into the PSD as PSD expects. */
  layers: PsdExportNode[];
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

// ─── Build PSD ────────────────────────────────────────────────────────────────

/** Encode a list of pixel layers + canvas size as a PSD file (Uint8Array of
 *  PSD bytes). Only pixel data + per-layer mask + opacity + blendMode +
 *  visibility are written; everything else (groups, text, shapes, adjustments)
 *  must be excluded by the caller. */
function nodeToLayer(node: PsdExportNode): Layer {
  if (node.kind === "group") {
    // Reverse to top-first for PSD.
    const children: Layer[] = [];
    for (let i = node.children.length - 1; i >= 0; i--) {
      children.push(nodeToLayer(node.children[i]));
    }
    return {
      name: node.name,
      hidden: !node.visible,
      opacity: node.opacity,
      blendMode: blendModeToPsd(node.blendMode),
      opened: node.opened,
      children,
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
  const layers: Layer[] = [];
  // Reverse: input is bottom-first, PSD's children are top-first.
  for (let i = input.layers.length - 1; i >= 0; i--) {
    layers.push(nodeToLayer(input.layers[i]));
  }

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
    invalidateTextLayers: true,
    psb: false,
  });
}
