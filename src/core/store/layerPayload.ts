import type { PixelFormat } from "@/types";

/** A layer's buffer size and canvas position. */
export interface LayerGeometry {
  layerWidth: number;
  layerHeight: number;
  offsetX: number;
  offsetY: number;
}

/** One layer's pixels in its native format: `Float32Array` for rgba32f,
 *  `Uint8Array` (4 B/px) for rgba8, `Uint8Array` (1 B/px) for indexed8. */
export interface LayerPayload {
  format: PixelFormat;
  data: Uint8Array | Float32Array;
  /** Layer-local geometry; absent means canvas-sized at (0, 0). */
  geo?: LayerGeometry;
}

/**
 * Pixel data a mounting Canvas hydrates its GPU layers from: tab restore,
 * history jumps across a size / format change, canvas transforms, colour-mode
 * conversion, GPU device recovery and file open. Holds the typed arrays
 * directly.
 *
 * Layer init only reads it; once the canvas is ready the owner drops it
 * (`useTabs().releaseMountedLayerData`), releasing the CPU copy.
 */
export interface LayerDataBundle {
  layers: Map<string, LayerPayload>;
  /** Baked adjustment-layer selection masks (canvas-sized rgba8), keyed by
   *  the adjustment layer's id. */
  adjustmentMasks: Map<string, Uint8Array>;
}

export function createLayerDataBundle(): LayerDataBundle {
  return { layers: new Map(), adjustmentMasks: new Map() };
}
