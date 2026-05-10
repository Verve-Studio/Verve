import type { GpuDevice } from "../device/GpuDevice";
import type { GpuLayer } from "../types";
import type { PixelFormat, RGBAColor } from "@/types";
import { createGpuTexture } from "../utils";
import { destroyTrackedTexture } from "@/core/store/memoryStore";
import { getStrategy } from "./formats";

/** Layer-local dirty rectangle. */
export interface LayerDirtyRect {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
}

interface Entry {
  texture: GPUTexture;
  dirty: LayerDirtyRect | null;
  version: number;
  /** Cached layerWidth so the store can detect grow-induced texture re-creation
   *  if needed. */
  width: number;
  height: number;
  format: PixelFormat;
}

/**
 * Owns the GPU texture, dirty rectangle, and content-version counter for every
 * {@link GpuLayer} in the document. The store is the single source of truth
 * for these — `GpuLayer.texture/dirtyRect/contentVersion` are deprecated mirrors
 * kept only for compatibility with code that hasn't migrated yet.
 *
 * Lifecycle is keyed by layer id. Callers must call {@link register} when a
 * layer is created and {@link dispose} when it's destroyed; the renderer's
 * `createLayer` / `destroyLayer` handle this automatically.
 */
export class LayerTextureStore {
  private readonly device: GPUDevice;
  private readonly entries = new Map<string, Entry>();

  constructor(gpu: GpuDevice) {
    this.device = gpu.device;
  }

  /** Allocate a fresh GPU texture matching the layer's format + dimensions and
   *  register it under the layer's id. The returned texture is also attached
   *  to `layer.texture` for backwards compatibility. */
  register(layer: GpuLayer): GPUTexture {
    const strategy = getStrategy(layer.format);
    const texture = createGpuTexture(
      this.device,
      layer.layerWidth,
      layer.layerHeight,
      null,
      strategy.gpuTextureFormat,
    );
    this.entries.set(layer.id, {
      texture,
      dirty: null,
      version: 0,
      width: layer.layerWidth,
      height: layer.layerHeight,
      format: layer.format,
    });
    layer.texture = texture;
    layer.contentVersion = 0;
    return texture;
  }

  /** Drop the entry — destroys the GPU texture. Idempotent. */
  dispose(layerId: string): void {
    const e = this.entries.get(layerId);
    if (!e) return;
    destroyTrackedTexture(e.texture);
    this.entries.delete(layerId);
  }

  /** Get the GPU texture for a layer. Throws if not registered. */
  getTexture(layer: GpuLayer): GPUTexture {
    const e = this.entries.get(layer.id);
    if (!e) {
      throw new Error(
        `LayerTextureStore: layer ${layer.id} is not registered`,
      );
    }
    return e.texture;
  }

  /** Get the texture for a layer that may be undefined (chained via `?.`). */
  getTextureOrNull(layer: GpuLayer | undefined): GPUTexture | null {
    if (!layer) return null;
    const e = this.entries.get(layer.id);
    return e ? e.texture : null;
  }

  /** Latest content version for the layer (0 if unregistered). */
  getVersion(layerId: string): number {
    const e = this.entries.get(layerId);
    return e ? e.version : 0;
  }

  /** Current dirty rectangle (or null). */
  getDirty(layerId: string): LayerDirtyRect | null {
    const e = this.entries.get(layerId);
    return e ? e.dirty : null;
  }

  /** Expand the dirty region by the given layer-local rectangle. */
  markDirty(layer: GpuLayer, lx: number, ly: number, rx: number, ry: number): void {
    const e = this.entries.get(layer.id);
    if (!e) return;
    if (!e.dirty) {
      e.dirty = { lx, ly, rx, ry };
    } else {
      e.dirty.lx = Math.min(e.dirty.lx, lx);
      e.dirty.ly = Math.min(e.dirty.ly, ly);
      e.dirty.rx = Math.max(e.dirty.rx, rx);
      e.dirty.ry = Math.max(e.dirty.ry, ry);
    }
  }

  /** Mark the entire layer dirty (full re-upload on next flush). */
  markFullDirty(layer: GpuLayer): void {
    this.markDirty(layer, 0, 0, layer.layerWidth, layer.layerHeight);
  }

  /** Clear the dirty region (called after upload). */
  clearDirty(layerId: string): void {
    const e = this.entries.get(layerId);
    if (!e) return;
    e.dirty = null;
    // Mirror back to layer for callers still reading the field.
    // (We don't have the layer object handy here, so callers that need the
    // mirror updated should do so via clearDirtyOnLayer.)
  }

  /**
   * Upload the layer's CPU pixel data to its GPU texture. If a dirty rect is
   * set, only that sub-region is uploaded. Bumps the content version. Caller
   * supplies a palette when `layer.format === 'indexed8'`.
   *
   * Returns the canvas-space dirty rect that was uploaded (for callers that
   * track frame-level invalidation), or null if the entire layer was uploaded.
   */
  flush(
    layer: GpuLayer,
    palette: readonly RGBAColor[] | undefined,
  ): { canvasX: number; canvasY: number; w: number; h: number } {
    const e = this.entries.get(layer.id);
    if (!e) {
      throw new Error(
        `LayerTextureStore: cannot flush unregistered layer ${layer.id}`,
      );
    }
    e.version++;
    layer.contentVersion = e.version;
    const strategy = getStrategy(layer.format);

    // indexed8 always re-uploads the whole layer (palette dependency); rgba8
    // and rgba32f patch-upload when a dirty rect is present.
    if (e.dirty && layer.format !== "indexed8") {
      const rect = e.dirty;
      e.dirty = null;
      strategy.uploadPatch(this.device, e.texture, layer, rect);
      return {
        canvasX: layer.offsetX + rect.lx,
        canvasY: layer.offsetY + rect.ly,
        w: rect.rx - rect.lx,
        h: rect.ry - rect.ly,
      };
    }
    e.dirty = null;
    strategy.uploadFull(this.device, e.texture, layer, palette);
    return {
      canvasX: layer.offsetX,
      canvasY: layer.offsetY,
      w: layer.layerWidth,
      h: layer.layerHeight,
    };
  }

  /** Replace the GPU texture for an existing layer (used by grow / replaceLayerData). */
  replaceTexture(
    layer: GpuLayer,
    newTexture: GPUTexture,
    newWidth: number,
    newHeight: number,
    newFormat: PixelFormat,
  ): void {
    const e = this.entries.get(layer.id);
    if (e) {
      destroyTrackedTexture(e.texture);
      e.texture = newTexture;
      e.dirty = null;
      e.width = newWidth;
      e.height = newHeight;
      e.format = newFormat;
    } else {
      this.entries.set(layer.id, {
        texture: newTexture,
        dirty: null,
        version: 0,
        width: newWidth,
        height: newHeight,
        format: newFormat,
      });
    }
    layer.texture = newTexture;
  }
}
