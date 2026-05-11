import type { GpuLayer } from "../../types";
import type { PixelFormat, RGBAColor } from "@/types";
import type { LayerDirtyRect } from "../LayerTextureStore";

/**
 * Per-format dispatch for layer-local pixel I/O, GPU upload, and growth.
 * Three implementations in this folder (Rgba8, Rgba32f, Indexed8) — the
 * renderer (and store) routes format-specific work through `getStrategy(format)`
 * instead of branching inline.
 *
 * Adding a new format becomes one new strategy file plus the registry entry.
 */
export interface PixelFormatStrategy {
  readonly format: PixelFormat;
  readonly bytesPerPixel: number;
  readonly gpuTextureFormat: GPUTextureFormat;

  /** Allocate a fresh CPU pixel buffer for a layer of the given dimensions. */
  allocateBuffer(width: number, height: number): Uint8Array | Float32Array;

  /** Sample a single pixel from `layer.data` at layer-local (x, y). Returns
   *  values in the format's native range:
   *  - rgba8 / indexed8: 0–255
   *  - rgba32f: 0.0–1.0 (or > 1 for HDR), alpha 0.0–1.0
   *  Out-of-bounds returns [0,0,0,0]. */
  samplePixel(
    layer: GpuLayer,
    x: number,
    y: number,
  ): [number, number, number, number];

  /** Write a single pixel into `layer.data` at layer-local (x, y). Caller
   *  passes values in the layer's native range. Out-of-bounds is a no-op.
   *  Doesn't touch the GPU. */
  drawPixel(
    layer: GpuLayer,
    x: number,
    y: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void;

  /** Upload the full layer data to its GPU texture. */
  uploadFull(
    device: GPUDevice,
    texture: GPUTexture,
    layer: GpuLayer,
    palette: readonly RGBAColor[] | undefined,
  ): void;

  /** Upload a sub-region of the layer to its GPU texture. */
  uploadPatch(
    device: GPUDevice,
    texture: GPUTexture,
    layer: GpuLayer,
    rect: LayerDirtyRect,
  ): void;

  /** Re-blit existing pixel data into a new (larger) buffer at the given
   *  offset. Used by `growLayerToFit`. The destination buffer matches this
   *  strategy's `allocateBuffer` shape. */
  reblitForGrow(
    src: GpuLayer,
    dstBuffer: Uint8Array | Float32Array,
    dstWidth: number,
    copyX: number,
    copyY: number,
  ): void;

  /** Direct upload after a grow (no palette expansion). Indexed8 leaves the
   *  texture untouched here — the caller is expected to re-flush with a palette. */
  uploadAfterGrow(
    device: GPUDevice,
    texture: GPUTexture,
    width: number,
    height: number,
    data: Uint8Array | Float32Array,
  ): void;
}
