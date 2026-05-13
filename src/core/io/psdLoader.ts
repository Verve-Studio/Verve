import { readPsd, type Psd, type Layer, type BlendMode } from "ag-psd";
import type { BlendMode as VerveBlendMode } from "@/types";
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

export type PsdImportedNode = PsdImportedLayer | PsdImportedGroup;

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
    // Adjustment layer / smart object / text layer / etc. — out of scope.
    // ag-psd attaches a `text`, `adjustment`, `placedLayer`, etc. property to
    // these. The cheapest detection: no image data + a non-pixel marker.
    const hasImageOrCanvas = !!(layer.imageData || layer.canvas);
    const isPixelLeaf =
      hasImageOrCanvas &&
      !("text" in layer && (layer as { text?: unknown }).text) &&
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
