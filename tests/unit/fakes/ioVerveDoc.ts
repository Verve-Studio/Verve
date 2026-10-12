// Builds `.verve` container bytes the way `useFileOps.encodeDocument` does
// (same field layout, same serialize* helpers), without React or a canvas.
// Used by the src/core/io document round-trip tests.
import type {
  BackgroundFill,
  Brush,
  LayerState,
  PixelBrush,
  PixelFormat,
  RGBAColor,
  SpritesheetState,
  SwatchGroup,
} from "@/types";
import type { LayerGeometry } from "@/core/store/layerPayload";
import { VerveBlobWriter } from "@/core/io/verveContainer";
import {
  serializeBrushes,
  serializeLayer,
  serializeLayerPixels,
  serializePixelBrushes,
  VERVE_DOC_VERSION,
  type LiveLayerPixels,
} from "@/core/io/verveDocument";

export interface FakeLayerPixels {
  format: PixelFormat;
  data: Uint8Array | Float32Array;
  geo: LayerGeometry;
}

export interface FakeDocument {
  pixelFormat: PixelFormat;
  width: number;
  height: number;
  backgroundFill?: BackgroundFill;
  activeLayerId: string | null;
  layers: LayerState[];
  /** Pixels per pixel-bearing layer id (what `exportLayerData` returns). */
  pixels: Map<string, FakeLayerPixels>;
  /** Adjustment masks per adjustment layer id. */
  adjustmentMasks?: Map<string, Uint8Array>;
  swatches: RGBAColor[];
  swatchGroups: SwatchGroup[];
  pixelBrushes?: PixelBrush[];
  brushes?: Brush[];
  activeBrushId?: string | null;
  spritesheet?: SpritesheetState;
  iccProfile?: Uint8Array | null;
}

function liveOf(p: FakeLayerPixels): LiveLayerPixels {
  const bytes = new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength);
  return {
    format: p.format,
    geo: p.geo,
    source: { byteLength: bytes.byteLength, deflate: p.format !== "rgba32f", view: () => bytes },
  };
}

/** Serialize `d` to container bytes, mirroring `useFileOps.encodeDocument`. */
export async function encodeFakeDocument(d: FakeDocument): Promise<Uint8Array> {
  const blobs = new VerveBlobWriter();
  const doc = {
    version: VERVE_DOC_VERSION,
    pixelFormat: d.pixelFormat,
    canvas: { width: d.width, height: d.height, backgroundFill: d.backgroundFill ?? "transparent" },
    activeLayerId: d.activeLayerId,
    layers: d.layers.map((l) => {
      if ("type" in l && l.type === "adjustment") {
        const mask = d.adjustmentMasks?.get(l.id) ?? null;
        return { ...l, adjustmentMask: mask ? blobs.add(mask) : null };
      }
      if ("type" in l && l.type === "group") return l;
      const px = d.pixels.get(l.id);
      return {
        ...serializeLayer(l, blobs),
        pixels: serializeLayerPixels(px ? liveOf(px) : null, blobs),
      };
    }),
    swatches: d.swatches,
    swatchGroups: d.swatchGroups,
    pixelBrushes: serializePixelBrushes(d.pixelBrushes ?? [], blobs),
    brushes: serializeBrushes(d.brushes ?? [], blobs),
    activeBrushId: d.activeBrushId ?? null,
    spritesheet: d.spritesheet,
    iccProfile: d.iccProfile ? blobs.add(d.iccProfile) : null,
  };
  const chunks: Uint8Array[] = [];
  await blobs.write(doc, async (c) => {
    chunks.push(c);
  });
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
