/**
 * Binary payloads of a `.verve` document: how layer pixels, adjustment masks,
 * frame content, pixel and paint brushes and the ICC profile map to container blobs
 * (`verveContainer.ts`) and back to the in-memory typed arrays.
 *
 * Version 7 stores every payload as a blob, layer pixels in the layer's own
 * format (rgba32f floats, rgba8 bytes, indexed8 indices) with its geometry.
 * Older documents (≤ 6) embedded rgba8 layers and masks as PNG data URLs and
 * other payloads as base64; `readVervePayloads` still reads those.
 */
import type { Brush, FrameLayerState, LayerState, PixelBrush, PixelFormat } from "@/types";
import { isFrameLayer } from "@/types";
import {
  createLayerDataBundle,
  type LayerDataBundle,
  type LayerGeometry,
  type LayerPayload,
} from "@/core/store/layerPayload";
import {
  deserializePixelBrush,
  type SerializedPixelBrush,
} from "@/core/store/pixelBrushStore";
import { base64ToBytes } from "@/utils/base64";
import {
  deserializeBrush,
  serializeBrush,
  serializedTipPayloads,
} from "@/core/tools/Brush/brushPreset";
import { loadImagePixels } from "./imageLoader";
import { isBlobRef, type LiveBlobSource, type VerveBlobWriter } from "./verveContainer";

export const VERVE_DOC_VERSION = 7;

/** A layer's pixels in the document header. */
interface SavedPixels {
  format: PixelFormat;
  /** Blob reference. */
  data: string;
  geo: LayerGeometry;
}

/** Per-layer payload fields stored next to the layer state. */
export interface SavedLayerPayloads {
  pixels?: SavedPixels | null;
  /** Blob reference to the canvas-sized rgba8 adjustment mask. */
  adjustmentMask?: string | null;
  // ── Version ≤ 6 (read only) ──
  layerDataRGBA8?: string | null;
  layerDataF32?: string | null;
  layerDataIndexed?: string | null;
  layerGeo?: LayerGeometry | null;
  adjustmentMaskPng?: string | null;
}

/** Layer state with a frame's content bytes replaced by a blob reference. */
type SerializedLayer = LayerState | (Omit<FrameLayerState, "content"> & {
  content: { rgba: string; width: number; height: number } | null;
});

// ─── Writing ─────────────────────────────────────────────────────────────────

/** Layer state ready for the JSON header: frame content goes to a blob. */
export function serializeLayer(
  layer: LayerState,
  blobs: VerveBlobWriter,
): SerializedLayer {
  if (isFrameLayer(layer) && layer.content) {
    return {
      ...layer,
      content: { ...layer.content, rgba: blobs.add(layer.content.rgba) },
    };
  }
  return layer;
}

/** A layer's pixels as the canvas exposes them for saving: read from the
 *  live layer buffer while the file is written, not copied up front. */
export interface LiveLayerPixels {
  format: PixelFormat;
  geo: LayerGeometry;
  source: LiveBlobSource;
}

export function serializeLayerPixels(
  pixels: LiveLayerPixels | null,
  blobs: VerveBlobWriter,
): SavedPixels | null {
  if (!pixels) return null;
  return { format: pixels.format, data: blobs.add(pixels.source), geo: pixels.geo };
}

export function serializePixelBrushes(
  brushes: readonly PixelBrush[],
  blobs: VerveBlobWriter,
): SerializedPixelBrush[] {
  return brushes.map((b) => ({ ...b, rgba: blobs.add(b.rgba) }));
}

/** The document's paint brushes (bitmap tips go to blobs). */
export function serializeBrushes(
  brushes: readonly Brush[],
  blobs: VerveBlobWriter,
): unknown[] {
  return brushes.map((b) => serializeBrush(b, (bytes) => blobs.add(bytes)));
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export interface VervePayloads {
  /** Layer states with frame content resolved to bytes. */
  layers: LayerState[];
  data: LayerDataBundle;
  pixelBrushes: PixelBrush[];
  /** The document's paint brushes (version ≥ 7; empty before). */
  brushes: Brush[];
  iccProfile: Uint8Array | undefined;
}

/**
 * Resolve every binary payload of a parsed document. `blob` resolves a
 * container blob reference; it is null for legacy (pre-container) JSON files.
 */
export async function readVervePayloads(
  doc: {
    layers: Array<LayerState & SavedLayerPayloads>;
    pixelBrushes?: unknown;
    brushes?: unknown;
    iccProfile?: unknown;
    iccProfileBase64?: unknown;
  },
  blob: ((ref: string) => Promise<Uint8Array>) | null,
  canvasWidth: number,
  canvasHeight: number,
): Promise<VervePayloads> {
  // A string payload is a blob reference (container) or base64 (legacy).
  const bytesOf = (value: string): Promise<Uint8Array> | Uint8Array =>
    blob && isBlobRef(value) ? blob(value) : base64ToBytes(value);

  const data = createLayerDataBundle();
  const layers: LayerState[] = [];
  for (const raw of doc.layers) {
    const {
      pixels,
      adjustmentMask,
      layerDataRGBA8,
      layerDataF32,
      layerDataIndexed,
      layerGeo,
      adjustmentMaskPng,
      ...meta
    } = raw;
    const id = meta.id;

    if (pixels) {
      const bytes = await bytesOf(pixels.data);
      data.layers.set(id, {
        format: pixels.format,
        data:
          pixels.format === "rgba32f"
            ? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
            : bytes,
        geo: pixels.geo,
      });
    } else if (layerDataF32 || layerDataIndexed || layerDataRGBA8) {
      data.layers.set(
        id,
        await readLegacyPixels(
          { layerDataRGBA8, layerDataF32, layerDataIndexed },
          layerGeo ?? undefined,
          bytesOf,
          canvasWidth,
          canvasHeight,
        ),
      );
    }

    if (adjustmentMask) {
      data.adjustmentMasks.set(id, await bytesOf(adjustmentMask));
    } else if (adjustmentMaskPng) {
      const decoded = await loadImagePixels(adjustmentMaskPng);
      data.adjustmentMasks.set(
        id,
        fitRgba8(decoded.data as Uint8Array, decoded.width, decoded.height, canvasWidth, canvasHeight),
      );
    }

    const layer = meta as unknown as LayerState;
    if (isFrameLayer(layer) && layer.content) {
      const rgba = layer.content.rgba as unknown;
      layers.push({
        ...layer,
        content:
          typeof rgba === "string"
            ? { ...layer.content, rgba: await bytesOf(rgba) }
            : null,
      });
    } else {
      layers.push(layer);
    }
  }

  // Pixel brushes: resolve each payload, then validate.
  const pixelBrushes: PixelBrush[] = [];
  if (Array.isArray(doc.pixelBrushes)) {
    for (const raw of doc.pixelBrushes as Array<Record<string, unknown>>) {
      const rgba = raw && typeof raw.rgba === "string" ? raw.rgba : null;
      if (!rgba) continue;
      let bytes: Uint8Array;
      try {
        bytes = await bytesOf(rgba);
      } catch {
        continue;
      }
      const brush = deserializePixelBrush(raw, () => bytes);
      if (brush) pixelBrushes.push(brush);
    }
  }

  // Paint brushes: resolve every bitmap-tip payload first (blobs are
  // async), then rebuild each brush.
  const brushes: Brush[] = [];
  if (Array.isArray(doc.brushes)) {
    const raws = (doc.brushes as unknown[]).filter(
      (b): b is Record<string, unknown> => typeof b === "object" && b !== null,
    );
    const resolved = new Map<string, Uint8Array>();
    for (const raw of raws) {
      for (const ref of serializedTipPayloads(raw)) {
        if (resolved.has(ref)) continue;
        try {
          resolved.set(ref, await bytesOf(ref));
        } catch {
          // Missing tip data: the brush falls back to a round tip.
        }
      }
    }
    for (const raw of raws) {
      brushes.push(
        deserializeBrush(raw, (ref) => {
          const bytes = resolved.get(ref);
          if (!bytes) throw new Error(`Missing brush tip data (${ref}).`);
          return bytes;
        }),
      );
    }
  }

  let iccProfile: Uint8Array | undefined;
  const icc = doc.iccProfile ?? doc.iccProfileBase64;
  if (typeof icc === "string" && icc) {
    try {
      iccProfile = await bytesOf(icc);
    } catch {
      iccProfile = undefined;
    }
  }

  return { layers, data, pixelBrushes, brushes, iccProfile };
}

// ─── Version ≤ 6 ─────────────────────────────────────────────────────────────

async function readLegacyPixels(
  fields: Pick<SavedLayerPayloads, "layerDataRGBA8" | "layerDataF32" | "layerDataIndexed">,
  geo: LayerGeometry | undefined,
  bytesOf: (value: string) => Promise<Uint8Array> | Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
): Promise<LayerPayload> {
  if (fields.layerDataF32) {
    const bytes = await bytesOf(fields.layerDataF32);
    return {
      format: "rgba32f",
      data: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
      geo,
    };
  }
  if (fields.layerDataIndexed) {
    return { format: "indexed8", data: await bytesOf(fields.layerDataIndexed), geo };
  }
  // PNG data URL: layer-local when geometry was stored, else canvas-sized.
  const w = geo?.layerWidth ?? canvasWidth;
  const h = geo?.layerHeight ?? canvasHeight;
  const decoded = await loadImagePixels(fields.layerDataRGBA8!);
  return {
    format: "rgba8",
    data: fitRgba8(decoded.data as Uint8Array, decoded.width, decoded.height, w, h),
    geo,
  };
}

/** Copy an RGBA8 image into a w×h buffer (cropping or transparent-padding). */
function fitRgba8(
  src: Uint8Array,
  sw: number,
  sh: number,
  w: number,
  h: number,
): Uint8Array {
  if (sw === w && sh === h) return src;
  const out = new Uint8Array(w * h * 4);
  const cw = Math.min(sw, w);
  for (let y = 0; y < Math.min(sh, h); y++) {
    out.set(src.subarray(y * sw * 4, (y * sw + cw) * 4), y * w * 4);
  }
  return out;
}
