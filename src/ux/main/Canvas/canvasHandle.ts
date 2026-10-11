import { useImperativeHandle, useRef } from "react";
import type React from "react";
import type {
  GpuLayer,
  WebGPURenderer,
  RenderPlanEntry,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import type { LayerState, RGBAColor, PixelFormat } from "@/types";
import { isGroupLayer } from "@/types";
import {
  buildRenderPlan as buildCanvasRenderPlan,
  buildSubPlan,
} from "./canvasPlan";

import {
  rasterizeDocument,
  type RasterBackend,
  type RasterReason,
} from "@/graphics/rasterization";
import { getPixelOpsSync, matchPaletteIndices, syncIfGrew } from "@/wasm";
import { DocumentChangedError } from "@/core/io/verveContainer";
import { forgetLayerRaster } from "@/core/services/useGpuLayerSync";
import type { LiveLayerPixels } from "@/core/io/verveDocument";
import {
  snapshotFull,
  snapshotLayer,
  snapshotMatches,
  writeSnapshotTiles,
  type TiledLayerSnapshot,
} from "@/core/store/tiledSnapshot";
import {
  clampF32ToUint8,
  linearToSrgbChannel,
  srgbToLinearChannel,
} from "@/utils/pixelFormatConvert";

// ─── Public handle type (imported by App.tsx and other callers) ────────────

export interface CanvasHandle {
  /** A layer's pixels in its native format (rgba32f floats, rgba8 bytes,
   *  indexed8 indices) with its layer-local geometry, for saving. Nothing
   *  is copied: `source.view()` reads the live buffer and throws
   *  `DocumentChangedError` once the layer's pixels, size or format change
   *  (or the layer is destroyed). */
  exportLayerData: (layerId: string) => LiveLayerPixels | null;
  /** Copy a baked adjustment mask (canvas-sized rgba8). */
  exportAdjustmentMask: (layerId: string) => Uint8Array | null;
  /**
   * Composite all visible layers (in state order) and return the raw RGBA
   * pixel data together with the image dimensions.
   * Returns null when the renderer is not yet initialised.
   */
  rasterizeComposite: (
    reason: RasterReason,
  ) => Promise<{
    data: Uint8Array | Float32Array;
    width: number;
    height: number;
    backendUsed: RasterBackend;
  }>;
  /** Rasterize a provided subset of layer state using the same plan builder logic as canvas rendering. */
  rasterizeLayers: (
    layers: readonly LayerState[],
    reason: RasterReason,
  ) => Promise<{
    data: Uint8Array | Float32Array;
    width: number;
    height: number;
    backendUsed: RasterBackend;
  }>;
  /** Return a copy of a layer's raw RGBA pixel data IN CANVAS-SIZE buffer (pixels outside layer bounds are transparent). */
  getLayerPixels: (layerId: string) => Uint8Array | null;
  /** Return a layer's raw RGBA pixel data in **layer-local** size (always 8-bit
   *  RGBA, even for rgba32f layers — converted on read), plus its offset on
   *  the canvas. Used by exporters (e.g. PSD) that preserve per-layer geometry
   *  rather than working off a flattened buffer. */
  getLayerExportData: (
    layerId: string,
  ) => {
    pixels: Uint8Array;
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
  } | null;
  /**
   * Create a new GL layer, fill it with data, and render.
   * data is canvas-size RGBA. Call BEFORE dispatching ADD_LAYER so the sync effect is a no-op.
   * offsetX/offsetY/lw/lh let you specify exact layer bounds (for paste from clipboard).
   */
  prepareNewLayer: (
    layerId: string,
    name: string,
    data: Uint8Array | Float32Array,
    lw?: number,
    lh?: number,
    ox?: number,
    oy?: number,
    /** Layer pixel format. Default 'rgba8'. Pass 'rgba32f' when `data` is a
     *  Float32Array (e.g. result of rasterising in an f32 document) — without
     *  this the routine creates an rgba8 layer and `Uint8Array.set(Float32Array)`
     *  clamps every float in [0,1] to 0, producing a transparent black layer. */
    format?: import("@/types").PixelFormat,
  ) => void;
  /** Zero out every pixel in a layer that is covered by the selection mask (canvas-space), then flush+render. */
  clearLayerPixels: (layerId: string, mask: Uint8Array) => void;
  /** Snapshot all current layers' raw pixel data + geometry for history. */
  captureAllLayerPixels: () => Map<string, Uint8Array | Float32Array>;
  /**
   * Tiled history snapshot of every layer. Tiles unchanged since the layer's
   * history base (the snapshot last captured or restored for it) are shared
   * with it; only tiles written since are copied. `prev` (the current
   * entry's snapshots) is used for content de-dup when a layer has no base
   * (new, grown, remounted). Sets each layer's history base to the result.
   */
  captureAllLayerSnapshots: (
    prev?: ReadonlyMap<string, TiledLayerSnapshot>,
  ) => Map<string, TiledLayerSnapshot>;
  /**
   * Return direct references to layer data buffers — no copy.
   * Only safe when the Canvas is about to unmount (tab switch / file open).
   * Do NOT use for history capture.
   */
  borrowAllLayerPixels: () => Map<string, Uint8Array | Float32Array>;
  /** Snapshot per-layer geometry (width/height/offset). */
  captureAllLayerGeometry: () => Map<
    string,
    {
      layerWidth: number;
      layerHeight: number;
      offsetX: number;
      offsetY: number;
    }
  >;
  /** Tiled history snapshots of the baked adjustment-layer masks (same
   *  sharing rules as {@link captureAllLayerSnapshots}). */
  captureAllAdjustmentMasks: (
    prev?: ReadonlyMap<string, TiledLayerSnapshot>,
  ) => Map<string, TiledLayerSnapshot>;
  /** Restore history snapshots + geometry and flush+render. Per layer, only
   *  the tiles that differ from what the layer currently holds are written
   *  (none when it already shows that snapshot). */
  restoreAllLayerPixels: (
    data: ReadonlyMap<string, TiledLayerSnapshot>,
    geometry?: Map<
      string,
      {
        layerWidth: number;
        layerHeight: number;
        offsetX: number;
        offsetY: number;
      }
    >,
    layerStateForRender?: readonly LayerState[],
  ) => void;
  /** Restore baked selection masks for adjustment layers and re-render. */
  restoreAllAdjustmentMasks: (
    masks: ReadonlyMap<string, TiledLayerSnapshot>,
  ) => void;
  /** Return full-canvas RGBA pixels that feed into the target adjustment layer. Float32Array for f32 docs, Uint8Array otherwise. */
  readAdjustmentInputPixels: (
    adjustmentLayerId: string,
  ) => Promise<Uint8Array | Float32Array | null>;
  /** Return a copy of a baked adjustment selection mask by adjustment layer ID. */
  getAdjustmentMaskPixels: (
    adjustmentLayerId: string,
  ) => Uint8Array | Float32Array | null;
  /** Rasterize only the children of a group layer, against a transparent background. Used by Merge Group. */
  rasterizeGroupChildren: (
    groupId: string,
    layers: readonly LayerState[],
    swatches: readonly RGBAColor[],
    reason: RasterReason,
  ) => Promise<{
    data: Uint8Array | Float32Array;
    width: number;
    height: number;
    backendUsed: RasterBackend;
  }>;
  /** Zoom to fit the whole canvas inside the current viewport with a small margin. */
  fitToWindow: () => void;
  /** The viewport's scroll offset (CSS px), to carry a view across a remount. */
  getViewScroll: () => { left: number; top: number } | null;
  /** Restore a scroll offset from `getViewScroll` (same zoom and size). */
  setViewScroll: (pos: { left: number; top: number }) => void;
  /**
   * Write a canvas-size RGBA pixel buffer into an existing layer, flush to GPU,
   * and re-render. `pixels` must be Uint8Array of length (canvasWidth × canvasHeight × 4),
   * the same format returned by `getLayerPixels`. Does NOT push to undo history.
   */
  writeLayerPixels: (layerId: string, pixels: Uint8Array) => void;
  /** A copy of a layer as a CANVAS-SIZE buffer in its native format:
   *  Float32 RGBA for rgba32f, RGBA bytes for rgba8, palette indices
   *  (255 = transparent / off-layer) for indexed8. */
  getLayerCanvasData: (layerId: string) => Uint8Array | Float32Array | null;
  /** Write a canvas-size buffer in the layer's native format (see
   *  `getLayerCanvasData`), growing the layer to cover its visible pixels.
   *  Flushes and re-renders. Does NOT push to undo history. */
  writeLayerCanvasData: (layerId: string, data: Uint8Array | Float32Array) => void;
  /** Re-flush every indexed8 layer with the supplied palette and re-render.
   *  Used by the palette-animation playback loop to swap the displayed
   *  colours without touching the underlying index buffer. No-op when there
   *  are no indexed8 layers. */
  repaintIndexedLayers: (palette: readonly RGBAColor[]) => void;
  /**
   * Register a baked selection mask for an adjustment layer.
   * selPixels is a full-canvas Uint8Array (1 byte per pixel, 255 = selected) from activeScope().selection.mask.
   * The R channel of the resulting WebGL layer drives the shader blend weight.
   */
  registerAdjustmentSelectionMask: (
    layerId: string,
    selPixels: Uint8Array,
  ) => void;
  /** Get raw pixel data for a layer in its native format (Uint8Array for rgba8/indexed8, Float32Array for rgba32f). */
  getLayerRawData: (layerId: string) => Uint8Array | Float32Array | null;
  /** Replace a layer's pixel data and GPU texture with new data in a new format. Flushes and re-renders. */
  replaceLayerData: (
    layerId: string,
    newData: Uint8Array | Float32Array,
    newFormat: PixelFormat,
    palette?: RGBAColor[],
  ) => void;
  /** Return the raw index buffer for an indexed8 layer as a canvas-sized Uint8Array (1 byte/pixel, 255 = off-layer). Returns null for non-indexed layers. */
  getLayerIndexData: (layerId: string) => Uint8Array | null;
  /** Create a full-canvas indexed8 GPU layer from a canvas-sized index buffer. Used by useLayers after merge/flatten. */
  prepareNewLayerIndexed: (
    layerId: string,
    name: string,
    indexData: Uint8Array,
  ) => void;
  /** Write a canvas-sized index buffer into an indexed8 layer without quantization. Flushes and re-renders. */
  writeLayerIndexData: (layerId: string, indexData: Uint8Array) => void;
  /** Return the GpuLayer object for a given layer ID, or null if not found. */
  getGpuLayer: (layerId: string) => GpuLayer | null;
  /**
   * Create GPU layer `newId` as a copy of `srcId`'s pixels, in the source's
   * native format and geometry (any layer kind, masks included). Call BEFORE
   * dispatching the new layer. Returns false when the source has no GPU data.
   */
  cloneLayerData: (srcId: string, newId: string, name: string) => boolean;
  /**
   * Grow a pixel layer's buffer so it covers the canvas rect [x0, x1] ×
   * [y0, y1] (inclusive; clamped to the canvas), as painting does. Pixel
   * layers start small and grow on demand — call before writing a region.
   */
  growLayerToCover: (layerId: string, x0: number, y0: number, x1: number, y1: number) => void;
  /**
   * Pre-populate a mask layer's GPU data from a selection mask before dispatching ADD_MASK_LAYER.
   * selPixels is a canvas-sized Uint8Array (1 byte/pixel, 0–255) from activeScope().selection.mask.
   * Canvas.tsx's layer-init effect skips layers already in glLayersRef, so the mask
   * will use this data instead of the default all-white fill.
   */
  prepareMaskLayer: (
    maskId: string,
    maskName: string,
    selPixels: Uint8Array,
  ) => void;
  /** Trigger a re-render of the canvas without modifying any layer data. Use after imperatively mutating GpuLayer.offsetX/Y. */
  invalidate: () => void;
  /**
   * For every raster layer, copy the pixels from the source cell rect into the
   * destination cell rect (same layer). All three pixel formats are handled
   * natively (rgba8, rgba32f, indexed8). Does NOT push to undo history.
   */
  copyCellRect: (
    srcX: number,
    srcY: number,
    dstX: number,
    dstY: number,
    cellW: number,
    cellH: number,
  ) => void;
}

function f32ToSrgbByte(v: number): number {
  const e = linearToSrgbChannel(v);
  return e <= 0 ? 0 : e >= 1 ? 255 : Math.round(e * 255);
}

let srgbLut: Float32Array | null = null;
/** sRGB byte → linear float, 256 entries. */
function srgbByteToLinearLut(): Float32Array {
  if (!srgbLut) {
    srgbLut = new Float32Array(256);
    for (let i = 0; i < 256; i++) srgbLut[i] = srgbToLinearChannel(i / 255);
  }
  return srgbLut;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

interface UseCanvasHandleParams {
  ref: React.ForwardedRef<CanvasHandle>;
  rendererRef: { readonly current: WebGPURenderer | null };
  glLayersRef: { readonly current: Map<string, GpuLayer> };
  adjustmentMaskMap: { readonly current: Map<string, GpuLayer> };
  layersStateRef: { readonly current: readonly LayerState[] };
  swatchesRef: { readonly current: readonly RGBAColor[] };
  /** Document pixel format — merge / rasterize plans must be built for it
   *  (e.g. indexed8 excludes adjustments, as the screen plan does). */
  pixelFormatRef: { readonly current: PixelFormat };
  /** Returns the correctly-filtered layers + mask map + full render plan. */
  buildRenderArgs: () => {
    layers: GpuLayer[];
    maskMap: Map<string, GpuLayer>;
    plan: RenderPlanEntry[];
  };
  /** Plan for flatten / export / merge output (no preview-only state). */
  buildOutputPlan: () => RenderPlanEntry[];
  width: number;
  height: number;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  pendingScrollRef: React.MutableRefObject<{
    scrollLeft: number;
    scrollTop: number;
  } | null>;
  onZoom: (zoom: number) => void;
  tiledMode?: boolean;
  /** Re-renders both the WebGPU canvas and (if active) the tiled 2D overlay. */
  requestRender: () => void;
}

// ─── History snapshot helpers ──────────────────────────────────────────────

/**
 * Snapshot one GPU layer for history and make the result its history base.
 * Returns null for an empty layer (its base is cleared, so the next capture
 * starts over with a full snapshot).
 */
function snapshotGpuLayer(
  renderer: WebGPURenderer | null,
  layer: GpuLayer,
  prev: TiledLayerSnapshot | undefined,
): TiledLayerSnapshot | null {
  const w = layer.layerWidth;
  const h = layer.layerHeight;
  const channels: 1 | 4 = layer.format === "indexed8" ? 1 : 4;
  if (!renderer) {
    return w * h > 0 ? snapshotFull(layer.data, w, h, channels, prev) : null;
  }
  const change = renderer.takeLayerHistoryChange(layer);
  const snap =
    w * h > 0 ? snapshotLayer(layer.data, w, h, channels, change, prev) : null;
  renderer.setLayerHistoryBase(layer, snap);
  return snap;
}

/**
 * Bring a GPU layer (same geometry and format as `snap`) to `snap`'s pixels,
 * writing only the tiles that can differ: those whose tile object differs
 * from the layer's history base, plus those written since the base was set.
 * Everything when the layer is `fresh` or has no usable base. Afterwards the
 * layer's history base is `snap`, so the next capture shares its tiles.
 */
function restoreGpuLayer(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  snap: TiledLayerSnapshot,
  fresh: boolean,
  palette: RGBAColor[] | undefined,
): boolean {
  const change = renderer.takeLayerHistoryChange(layer);
  let rect;
  if (
    !fresh &&
    change.kind !== "all" &&
    snapshotMatches(
      change.base,
      snap.width,
      snap.height,
      snap.channels,
      snap.float,
    )
  ) {
    const baseTiles = change.base.tiles;
    const written = change.kind === "tiles" ? change.tiles : null;
    rect = writeSnapshotTiles(
      snap,
      layer.data,
      (i) => snap.tiles[i] !== baseTiles[i] || (written !== null && written[i] !== 0),
    );
  } else {
    rect = writeSnapshotTiles(snap, layer.data);
  }
  if (rect) {
    renderer.markDirtyRect(layer, rect.lx, rect.ly, rect.rx, rect.ry);
    renderer.flushLayer(layer, palette);
  }
  renderer.setLayerHistoryBase(layer, snap);
  return rect !== null;
}

export function useCanvasHandle({
  ref,
  rendererRef,
  glLayersRef,
  adjustmentMaskMap,
  layersStateRef,
  swatchesRef,
  pixelFormatRef,
  buildRenderArgs,
  buildOutputPlan,
  width,
  height,
  viewportRef,
  pendingScrollRef,
  onZoom,
  tiledMode,
  requestRender,
}: UseCanvasHandleParams): void {
  const buildRenderArgsRef = useRef(buildRenderArgs);
  buildRenderArgsRef.current = buildRenderArgs;
  const buildOutputPlanRef = useRef(buildOutputPlan);
  buildOutputPlanRef.current = buildOutputPlan;

  const requireRenderer = (): WebGPURenderer => {
    const renderer = rendererRef.current;
    if (!renderer)
      throw new Error(
        "Rasterization failed because the GPU renderer is not ready.",
      );
    return renderer;
  };

  const requestRenderRef = useRef(requestRender);
  requestRenderRef.current = requestRender;

  const renderFromPlan = (): void => {
    requestRenderRef.current();
  };

  const rebuildPlanForLayers = (
    layers: readonly LayerState[],
  ): RenderPlanEntry[] => {
    const maskMap = new Map<string, GpuLayer>();
    for (const layer of layers) {
      if ("type" in layer && layer.type === "mask" && layer.visible) {
        const gl = glLayersRef.current.get(layer.id);
        if (gl) maskMap.set(layer.parentId, gl);
      }
    }
    return buildCanvasRenderPlan(
      layers,
      glLayersRef.current,
      maskMap,
      adjustmentMaskMap.current,
      // Merge / rasterize output: preview-bypass toggles must not apply.
      new Set(),
      swatchesRef.current as RGBAColor[],
      pixelFormatRef.current,
    );
  };

  useImperativeHandle(
    ref,
    () => ({
      exportLayerData: (layerId) => {
        const layer = glLayersRef.current.get(layerId);
        if (!layer) return null;
        const { format, layerWidth, layerHeight, offsetX, offsetY, wasmPtr } = layer;
        const version = layer.contentVersion;
        const byteLength = layer.data.byteLength;
        return {
          format,
          geo: { layerWidth, layerHeight, offsetX, offsetY },
          source: {
            byteLength,
            deflate: format !== "rgba32f",
            view: () => {
              // Same layer, same pixels (flushes bump contentVersion; grow,
              // format change and destroy swap the buffer / wasmPtr).
              if (
                glLayersRef.current.get(layerId) !== layer ||
                layer.contentVersion !== version ||
                layer.format !== format ||
                layer.layerWidth !== layerWidth ||
                layer.layerHeight !== layerHeight ||
                layer.offsetX !== offsetX ||
                layer.offsetY !== offsetY ||
                layer.wasmPtr !== wasmPtr
              ) {
                throw new DocumentChangedError();
              }
              // A WASM-heap layer's view detaches when the heap grows;
              // rebind before reading.
              const m = getPixelOpsSync();
              if (m) syncIfGrew(m);
              const d = layer.data;
              if (d.byteLength !== byteLength) throw new DocumentChangedError();
              return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
            },
          },
        };
      },

      getLayerExportData: (layerId) => {
        const renderer = rendererRef.current;
        const layer = glLayersRef.current.get(layerId);
        if (!renderer || !layer) return null;
        const raw = renderer.readLayerPixels(layer);
        // rgba32f is scene-linear: encode to sRGB bytes.
        const u8 =
          raw instanceof Float32Array
            ? clampF32ToUint8(raw)
            : (raw as Uint8Array);
        return {
          pixels: u8,
          width: layer.layerWidth,
          height: layer.layerHeight,
          offsetX: layer.offsetX,
          offsetY: layer.offsetY,
        };
      },

      exportAdjustmentMask: (layerId) => {
        const maskLayer = adjustmentMaskMap.current.get(layerId);
        return maskLayer ? (maskLayer.data as Uint8Array).slice() : null;
      },

      rasterizeComposite: async (reason) => {
        const renderer = requireRenderer();
        const plan = buildOutputPlanRef.current();
        const result = await rasterizeDocument({
          plan,
          width: renderer.pixelWidth,
          height: renderer.pixelHeight,
          reason,
          renderer,
        });
        if (result.warning) {
          console.warn("[Rasterization]", result.warning);
        }
        return {
          data: result.data,
          width: result.width,
          height: result.height,
          backendUsed: result.backendUsed,
        };
      },

      rasterizeLayers: async (layers, reason) => {
        const renderer = requireRenderer();
        const plan = rebuildPlanForLayers(layers);
        const result = await rasterizeDocument({
          plan,
          width: renderer.pixelWidth,
          height: renderer.pixelHeight,
          reason,
          renderer,
        });
        if (result.warning) {
          console.warn("[Rasterization]", result.warning);
        }
        return {
          data: result.data,
          width: result.width,
          height: result.height,
          backendUsed: result.backendUsed,
        };
      },

      rasterizeGroupChildren: async (groupId, layers, swatches, reason) => {
        const renderer = requireRenderer();
        const group = layers.find((l) => l.id === groupId);
        if (!group || !isGroupLayer(group))
          throw new Error(`Group ${groupId} not found`);
        const maskMap = new Map<string, GpuLayer>();
        for (const layer of layers) {
          if ("type" in layer && layer.type === "mask" && layer.visible) {
            const gl = glLayersRef.current.get(layer.id);
            if (gl) maskMap.set((layer as { parentId: string }).parentId, gl);
          }
        }
        const plan = buildSubPlan(
          group.childIds,
          layers,
          glLayersRef.current,
          maskMap,
          adjustmentMaskMap.current,
          new Set(),
          swatches as RGBAColor[],
          pixelFormatRef.current,
        );
        const result = await rasterizeDocument({
          plan,
          width: renderer.pixelWidth,
          height: renderer.pixelHeight,
          reason,
          renderer,
        });
        return {
          data: result.data,
          width: result.width,
          height: result.height,
          backendUsed: result.backendUsed,
        };
      },

      getLayerPixels: (layerId) => {
        const renderer = rendererRef.current;
        const layer = glLayersRef.current.get(layerId);
        if (!renderer || !layer) return null;
        const w = renderer.pixelWidth;
        const h = renderer.pixelHeight;
        if (layer.format === "indexed8") {
          const result = new Uint8Array(w * h * 4);
          for (let ly2 = 0; ly2 < layer.layerHeight; ly2++) {
            const cy2 = layer.offsetY + ly2;
            if (cy2 < 0 || cy2 >= h) continue;
            for (let lx2 = 0; lx2 < layer.layerWidth; lx2++) {
              const cx2 = layer.offsetX + lx2;
              if (cx2 < 0 || cx2 >= w) continue;
              const idx = (layer.data as Uint8Array)[
                ly2 * layer.layerWidth + lx2
              ];
              const di = (cy2 * w + cx2) * 4;
              if (idx < swatchesRef.current.length) {
                const p = swatchesRef.current[idx];
                result[di] = p.r;
                result[di + 1] = p.g;
                result[di + 2] = p.b;
                result[di + 3] = p.a;
              }
            }
          }
          return result;
        }
        const result = new Uint8Array(w * h * 4);
        const isF32 = layer.format === "rgba32f";
        const src = layer.data;
        for (let ly = 0; ly < layer.layerHeight; ly++) {
          const cy = layer.offsetY + ly;
          if (cy < 0 || cy >= h) continue;
          for (let lx = 0; lx < layer.layerWidth; lx++) {
            const cx = layer.offsetX + lx;
            if (cx < 0 || cx >= w) continue;
            const si = (ly * layer.layerWidth + lx) * 4;
            const di = (cy * w + cx) * 4;
            if (isF32) {
              // Linear floats → sRGB bytes (transfer function, not ×255).
              result[di] = f32ToSrgbByte(src[si]);
              result[di + 1] = f32ToSrgbByte(src[si + 1]);
              result[di + 2] = f32ToSrgbByte(src[si + 2]);
              const a = src[si + 3];
              result[di + 3] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
            } else {
              result[di] = src[si];
              result[di + 1] = src[si + 1];
              result[di + 2] = src[si + 2];
              result[di + 3] = src[si + 3];
            }
          }
        }
        return result;
      },

      prepareNewLayer: (layerId, name, data, lw?, lh?, ox?, oy?, format?) => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        const useW = lw ?? renderer.pixelWidth;
        const useH = lh ?? renderer.pixelHeight;
        const useOx = ox ?? 0;
        const useOy = oy ?? 0;
        const layer = renderer.createLayer(
          layerId,
          name,
          useW,
          useH,
          useOx,
          useOy,
          format,
        );
        // `data` must already be in the layer's format and size (RGBA bytes,
        // floats, or 1-byte palette indices).
        if (
          data.length !== layer.data.length ||
          data instanceof Float32Array !== layer.data instanceof Float32Array
        ) {
          renderer.destroyLayer(layer);
          throw new Error(
            `Layer "${name}" data doesn't match its ${layer.format} format and size.`,
          );
        }
        (layer.data as Uint8Array | Float32Array).set(data as never);
        renderer.flushLayer(
          layer,
          layer.format === "indexed8"
            ? (swatchesRef.current as RGBAColor[])
            : undefined,
        );
        glLayersRef.current.set(layerId, layer);
        renderFromPlan();
      },

      clearLayerPixels: (layerId, mask) => {
        const renderer = rendererRef.current;
        const layer = glLayersRef.current.get(layerId);
        if (!renderer || !layer) return;
        const w = renderer.pixelWidth;
        const indexed = layer.format === "indexed8";
        for (let i = 0; i < mask.length; i++) {
          if (!mask[i]) continue;
          const cx = i % w;
          const cy = Math.floor(i / w);
          const lx = cx - layer.offsetX;
          const ly = cy - layer.offsetY;
          if (
            lx < 0 ||
            ly < 0 ||
            lx >= layer.layerWidth ||
            ly >= layer.layerHeight
          )
            continue;
          if (indexed) {
            // Indexed8 has 1 byte per pixel; 255 is the transparent sentinel.
            // No partial alpha — any selected pixel is wiped to transparent.
            const pi = ly * layer.layerWidth + lx;
            (layer.data as Uint8Array)[pi] = 255;
            continue;
          }
          const pi = (ly * layer.layerWidth + lx) * 4;
          const f = 1 - mask[i] / 255;
          if (layer.format === "rgba32f") {
            layer.data[pi] *= f;
            layer.data[pi + 1] *= f;
            layer.data[pi + 2] *= f;
            layer.data[pi + 3] *= f;
          } else {
            layer.data[pi] = Math.round(layer.data[pi] * f);
            layer.data[pi + 1] = Math.round(layer.data[pi + 1] * f);
            layer.data[pi + 2] = Math.round(layer.data[pi + 2] * f);
            layer.data[pi + 3] = Math.round(layer.data[pi + 3] * f);
          }
        }
        if (indexed) {
          renderer.flushLayer(
            layer,
            swatchesRef.current as import("@/types").RGBAColor[],
          );
        } else {
          renderer.flushLayer(layer);
        }
        renderFromPlan();
      },

      captureAllLayerPixels: () => {
        const result = new Map<string, Uint8Array | Float32Array>();
        for (const ls of layersStateRef.current) {
          const layer = glLayersRef.current.get(ls.id);
          if (layer) result.set(ls.id, layer.data.slice());
        }
        return result;
      },

      captureAllLayerSnapshots: (prev) => {
        const result = new Map<string, TiledLayerSnapshot>();
        const renderer = rendererRef.current;
        for (const ls of layersStateRef.current) {
          const layer = glLayersRef.current.get(ls.id);
          if (!layer) continue;
          const snap = snapshotGpuLayer(renderer, layer, prev?.get(ls.id));
          if (snap) result.set(ls.id, snap);
        }
        return result;
      },

      borrowAllLayerPixels: () => {
        const result = new Map<string, Uint8Array | Float32Array>();
        for (const ls of layersStateRef.current) {
          const layer = glLayersRef.current.get(ls.id);
          if (layer) result.set(ls.id, layer.data as Uint8Array | Float32Array);
        }
        return result;
      },

      captureAllLayerGeometry: () => {
        const result = new Map<
          string,
          {
            layerWidth: number;
            layerHeight: number;
            offsetX: number;
            offsetY: number;
          }
        >();
        for (const ls of layersStateRef.current) {
          const layer = glLayersRef.current.get(ls.id);
          if (layer)
            result.set(ls.id, {
              layerWidth: layer.layerWidth,
              layerHeight: layer.layerHeight,
              offsetX: layer.offsetX,
              offsetY: layer.offsetY,
            });
        }
        return result;
      },

      captureAllAdjustmentMasks: (prev) => {
        const result = new Map<string, TiledLayerSnapshot>();
        const renderer = rendererRef.current;
        for (const [layerId, maskLayer] of adjustmentMaskMap.current) {
          const snap = snapshotGpuLayer(renderer, maskLayer, prev?.get(layerId));
          if (snap) result.set(layerId, snap);
        }
        return result;
      },

      getViewScroll: () => {
        const vp = viewportRef.current;
        return vp ? { left: vp.scrollLeft, top: vp.scrollTop } : null;
      },

      setViewScroll: (pos) => {
        const apply = (): void => {
          const vp = viewportRef.current;
          if (!vp) return;
          vp.scrollLeft = pos.left;
          vp.scrollTop = pos.top;
        };
        apply();
        // Again once the remounted viewport has laid out at full size.
        requestAnimationFrame(apply);
      },

      fitToWindow: () => {
        const vp = viewportRef.current;
        if (!vp) return;
        const dpr = window.devicePixelRatio || 1;
        const scale = tiledMode ? 3 : 1;
        const logW = width * scale;
        const logH = height * scale;
        const zoom = parseFloat(
          Math.max(
            0.05,
            Math.min(
              32,
              Math.min(
                vp.clientWidth / (logW / dpr),
                vp.clientHeight / (logH / dpr),
              ) * 0.95,
            ),
          ).toFixed(4),
        );
        // Set pending scroll so useScrollZoom's layout effect applies centering
        // atomically with the zoom commit — avoids a rAF race on large canvases.
        const z = zoom / dpr;
        pendingScrollRef.current = {
          scrollLeft: Math.max(
            0,
            logW * z + (logW / 2) * z - vp.clientWidth / 2,
          ),
          scrollTop: Math.max(
            0,
            logH * z + (logH / 2) * z - vp.clientHeight / 2,
          ),
        };
        onZoom(zoom);
      },

      restoreAllLayerPixels: (data, geometry?, layerStateForRender?) => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        for (const [id, snap] of data) {
          const geo = geometry?.get(id);
          const fmt: PixelFormat = snap.float
            ? "rgba32f"
            : snap.channels === 1
              ? "indexed8"
              : "rgba8";
          let layer = glLayersRef.current.get(id);
          let fresh = false;
          if (
            !layer ||
            layer.layerWidth !== snap.width ||
            layer.layerHeight !== snap.height ||
            layer.format !== fmt
          ) {
            if (layer) renderer.destroyLayer(layer);
            layer = renderer.createLayer(
              id,
              layer?.name ?? "Restored",
              snap.width,
              snap.height,
              geo?.offsetX ?? 0,
              geo?.offsetY ?? 0,
              fmt,
            );
            glLayersRef.current.set(id, layer);
            fresh = true;
          } else if (geo) {
            layer.offsetX = geo.offsetX;
            layer.offsetY = geo.offsetY;
          }
          const wrote = restoreGpuLayer(
            renderer,
            layer,
            snap,
            fresh,
            fmt === "indexed8"
              ? (swatchesRef.current as RGBAColor[])
              : undefined,
          );
          // Parametric / linked layers re-rasterise from the restored state
          // on the next sync pass (the restored pixels may be a placeholder).
          if (wrote || fresh) forgetLayerRaster(layer);
        }
        // Note: layerStateForRender is currently unused — Canvas.tsx's doRender
        // builds the plan from the live state.layers via buildRenderPlan().
        // Tiled mode requires going through doRender so the 2D overlay is updated.
        void layerStateForRender;
        requestRenderRef.current();
      },

      restoreAllAdjustmentMasks: (masks) => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        for (const [layerId, existing] of adjustmentMaskMap.current) {
          if (!masks.has(layerId)) {
            renderer.destroyLayer(existing);
            adjustmentMaskMap.current.delete(layerId);
          }
        }
        for (const [layerId, snap] of masks) {
          let maskLayer = adjustmentMaskMap.current.get(layerId);
          let fresh = false;
          if (
            !maskLayer ||
            maskLayer.layerWidth !== snap.width ||
            maskLayer.layerHeight !== snap.height
          ) {
            if (maskLayer) renderer.destroyLayer(maskLayer);
            maskLayer = renderer.createLayer(
              `${layerId}:adjustment-mask`,
              "Adjustment Mask",
              snap.width,
              snap.height,
              0,
              0,
            );
            adjustmentMaskMap.current.set(layerId, maskLayer);
            fresh = true;
          }
          restoreGpuLayer(renderer, maskLayer, snap, fresh, undefined);
        }
        renderFromPlan();
      },

      readAdjustmentInputPixels: async (adjustmentLayerId) => {
        const renderer = rendererRef.current;
        if (!renderer) return null;
        const { plan } = buildRenderArgsRef.current();
        return renderer.readAdjustmentInputPlan(plan, adjustmentLayerId);
      },

      getAdjustmentMaskPixels: (adjustmentLayerId) => {
        const maskLayer = adjustmentMaskMap.current.get(adjustmentLayerId);
        if (!maskLayer) return null;
        return maskLayer.data as Uint8Array | Float32Array;
      },

      writeLayerPixels: (layerId, pixels) => {
        const renderer = rendererRef.current;
        const layer = glLayersRef.current.get(layerId);
        if (!renderer || !layer) return;
        const w = renderer.pixelWidth;
        const h = renderer.pixelHeight;

        if (layer.format === "indexed8") {
          matchPaletteIndices(
            pixels,
            swatchesRef.current as import("@/types").RGBAColor[],
            255,
          ).then((indices) => {
            for (let ly2 = 0; ly2 < layer.layerHeight; ly2++) {
              for (let lx2 = 0; lx2 < layer.layerWidth; lx2++) {
                const ci = (layer.offsetY + ly2) * w + (layer.offsetX + lx2);
                (layer.data as Uint8Array)[ly2 * layer.layerWidth + lx2] =
                  indices[ci];
              }
            }
            renderer.flushLayer(
              layer,
              swatchesRef.current as import("@/types").RGBAColor[],
            );
            renderFromPlan();
          });
          return;
        }

        // Scan the input for the bounding box of non-transparent pixels (canvas-space).
        // Operations like Free Transform / Perspective produce a canvas-sized buffer
        // where the result may extend beyond the layer's current rect (e.g. a perspective
        // skew that pushes corners outward). Without growing the layer first, those
        // out-of-rect pixels would be silently cropped.
        let minX = w,
          maxX = -1,
          minY = h,
          maxY = -1;
        for (let y = 0; y < h; y++) {
          const row = y * w;
          for (let x = 0; x < w; x++) {
            if (pixels[(row + x) * 4 + 3] !== 0) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX >= 0) {
          renderer.growLayerToFit(layer, minX, minY);
          renderer.growLayerToFit(layer, maxX, maxY);
        }

        // `pixels` is sRGB RGBA8 (the getLayerPixels format); rgba32f layers
        // store linear floats, so decode instead of copying bytes into them.
        const isF32 = layer.format === "rgba32f";
        const lut = isF32 ? srgbByteToLinearLut() : null;
        for (let ly = 0; ly < layer.layerHeight; ly++) {
          const cy = layer.offsetY + ly;
          if (cy < 0 || cy >= h) continue;
          for (let lx = 0; lx < layer.layerWidth; lx++) {
            const cx = layer.offsetX + lx;
            if (cx < 0 || cx >= w) continue;
            const si = (cy * w + cx) * 4;
            const di = (ly * layer.layerWidth + lx) * 4;
            if (lut) {
              layer.data[di] = lut[pixels[si]];
              layer.data[di + 1] = lut[pixels[si + 1]];
              layer.data[di + 2] = lut[pixels[si + 2]];
              layer.data[di + 3] = pixels[si + 3] / 255;
            } else {
              layer.data[di] = pixels[si];
              layer.data[di + 1] = pixels[si + 1];
              layer.data[di + 2] = pixels[si + 2];
              layer.data[di + 3] = pixels[si + 3];
            }
          }
        }
        renderer.flushLayer(layer);
        renderFromPlan();
      },

      repaintIndexedLayers: (palette) => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        let any = false;
        for (const layer of glLayersRef.current.values()) {
          if (layer.format !== "indexed8") continue;
          renderer.flushLayer(layer, palette as RGBAColor[]);
          any = true;
        }
        if (any) renderFromPlan();
      },

      registerAdjustmentSelectionMask: (layerId, selPixels) => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        const w = renderer.pixelWidth;
        const h = renderer.pixelHeight;
        let maskLayer = adjustmentMaskMap.current.get(layerId);
        if (!maskLayer) {
          maskLayer = renderer.createLayer(
            `${layerId}:adjustment-mask`,
            "Adjustment Mask",
            w,
            h,
            0,
            0,
          );
          adjustmentMaskMap.current.set(layerId, maskLayer);
        }
        const input =
          selPixels.length === w * h ? selPixels : new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
          const v = input[i];
          const di = i * 4;
          maskLayer.data[di] = v;
          maskLayer.data[di + 1] = v;
          maskLayer.data[di + 2] = v;
          maskLayer.data[di + 3] = 255;
        }
        renderer.flushLayer(maskLayer);
        renderFromPlan();
      },

      getLayerRawData: (layerId) => {
        const layer = glLayersRef.current.get(layerId);
        if (!layer) return null;
        return layer.data.slice() as Uint8Array | Float32Array;
      },

      replaceLayerData: (layerId, newData, newFormat, palette) => {
        const renderer = rendererRef.current;
        const layer = glLayersRef.current.get(layerId);
        if (!renderer || !layer) return;
        renderer.replaceLayerData(layer, newData, newFormat, palette);
        renderFromPlan();
      },

      getLayerIndexData: (layerId) => {
        const layer = glLayersRef.current.get(layerId);
        const renderer = rendererRef.current;
        if (!layer || !renderer || layer.format !== "indexed8") return null;
        const w = renderer.pixelWidth;
        const h = renderer.pixelHeight;
        const result = new Uint8Array(w * h).fill(255);
        for (let ly2 = 0; ly2 < layer.layerHeight; ly2++) {
          for (let lx2 = 0; lx2 < layer.layerWidth; lx2++) {
            const cx2 = layer.offsetX + lx2,
              cy2 = layer.offsetY + ly2;
            if (cx2 < 0 || cx2 >= w || cy2 < 0 || cy2 >= h) continue;
            result[cy2 * w + cx2] = (layer.data as Uint8Array)[
              ly2 * layer.layerWidth + lx2
            ];
          }
        }
        return result;
      },

      prepareNewLayerIndexed: (layerId, name, indexData) => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        const w = renderer.pixelWidth,
          h = renderer.pixelHeight;
        const layer = renderer.createLayer(
          layerId,
          name,
          w,
          h,
          0,
          0,
          "indexed8",
        );
        (layer.data as Uint8Array).set(indexData);
        renderer.flushLayer(
          layer,
          swatchesRef.current as import("@/types").RGBAColor[],
        );
        glLayersRef.current.set(layerId, layer);
        renderFromPlan();
      },

      getLayerCanvasData: (layerId) => {
        const renderer = rendererRef.current;
        const layer = glLayersRef.current.get(layerId);
        if (!renderer || !layer) return null;
        const w = renderer.pixelWidth;
        const h = renderer.pixelHeight;
        const ch = layer.format === "indexed8" ? 1 : 4;
        const out =
          layer.format === "rgba32f"
            ? new Float32Array(w * h * 4)
            : new Uint8Array(w * h * ch);
        if (layer.format === "indexed8") out.fill(255);
        const src = layer.data;
        for (let ly = 0; ly < layer.layerHeight; ly++) {
          const cy = layer.offsetY + ly;
          if (cy < 0 || cy >= h) continue;
          const x0 = Math.max(0, -layer.offsetX);
          const x1 = Math.min(layer.layerWidth, w - layer.offsetX);
          if (x1 <= x0) continue;
          const s = (ly * layer.layerWidth + x0) * ch;
          out.set(
            src.subarray(s, s + (x1 - x0) * ch) as never,
            (cy * w + layer.offsetX + x0) * ch,
          );
        }
        return out;
      },

      writeLayerCanvasData: (layerId, data) => {
        const renderer = rendererRef.current;
        const layer = glLayersRef.current.get(layerId);
        if (!renderer || !layer) return;
        const w = renderer.pixelWidth;
        const h = renderer.pixelHeight;
        const indexed = layer.format === "indexed8";
        const ch = indexed ? 1 : 4;
        if (
          data.length !== w * h * ch ||
          data instanceof Float32Array !== (layer.format === "rgba32f")
        ) {
          throw new Error(
            `Pixel data doesn't match layer "${layer.name}" (${layer.format}).`,
          );
        }
        // Grow the layer to cover the visible pixels: a transform result may
        // extend beyond the layer's current rect.
        let minX = w,
          maxX = -1,
          minY = h,
          maxY = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (indexed ? data[i] !== 255 : data[i * 4 + 3] !== 0) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX >= 0) {
          renderer.growLayerToFit(layer, minX, minY);
          renderer.growLayerToFit(layer, maxX, maxY);
        }
        for (let ly = 0; ly < layer.layerHeight; ly++) {
          const cy = layer.offsetY + ly;
          if (cy < 0 || cy >= h) continue;
          const x0 = Math.max(0, -layer.offsetX);
          const x1 = Math.min(layer.layerWidth, w - layer.offsetX);
          if (x1 <= x0) continue;
          const s = (cy * w + layer.offsetX + x0) * ch;
          layer.data.set(
            data.subarray(s, s + (x1 - x0) * ch) as never,
            (ly * layer.layerWidth + x0) * ch,
          );
        }
        renderer.markFullDirty(layer);
        renderer.flushLayer(
          layer,
          indexed ? (swatchesRef.current as RGBAColor[]) : undefined,
        );
        renderFromPlan();
      },

      writeLayerIndexData: (layerId, indexData) => {
        const layer = glLayersRef.current.get(layerId);
        const renderer = rendererRef.current;
        if (!layer || !renderer || layer.format !== "indexed8") return;
        const w = renderer.pixelWidth;
        for (let ly2 = 0; ly2 < layer.layerHeight; ly2++) {
          for (let lx2 = 0; lx2 < layer.layerWidth; lx2++) {
            const ci = (layer.offsetY + ly2) * w + (layer.offsetX + lx2);
            (layer.data as Uint8Array)[ly2 * layer.layerWidth + lx2] =
              indexData[ci];
          }
        }
        renderer.flushLayer(
          layer,
          swatchesRef.current as import("@/types").RGBAColor[],
        );
        renderFromPlan();
      },

      getGpuLayer: (layerId) => glLayersRef.current.get(layerId) ?? null,

      growLayerToCover: (layerId, x0, y0, x1, y1) => {
        const renderer = rendererRef.current;
        const layer = glLayersRef.current.get(layerId);
        if (!renderer || !layer) return;
        const cx = (x: number): number => Math.max(0, Math.min(renderer.pixelWidth - 1, Math.round(x)));
        const cy = (y: number): number => Math.max(0, Math.min(renderer.pixelHeight - 1, Math.round(y)));
        renderer.growLayerToFit(layer, cx(x0), cy(y0));
        renderer.growLayerToFit(layer, cx(x1), cy(y1));
      },

      cloneLayerData: (srcId, newId, name) => {
        const renderer = rendererRef.current;
        const src = glLayersRef.current.get(srcId);
        if (!renderer || !src) return false;
        const layer = renderer.createLayer(
          newId,
          name,
          src.layerWidth,
          src.layerHeight,
          src.offsetX,
          src.offsetY,
          src.format,
        );
        (layer.data as Uint8Array | Float32Array).set(src.data as never);
        renderer.flushLayer(
          layer,
          src.format === "indexed8"
            ? (swatchesRef.current as import("@/types").RGBAColor[])
            : undefined,
        );
        glLayersRef.current.set(newId, layer);
        return true;
      },

      prepareMaskLayer: (maskId, maskName, selPixels) => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        const w = renderer.pixelWidth;
        const h = renderer.pixelHeight;
        const layer = renderer.createLayer(maskId, maskName, w, h, 0, 0);
        for (let i = 0; i < w * h; i++) {
          const v = selPixels[i] ?? 0;
          layer.data[i * 4] = v;
          layer.data[i * 4 + 1] = v;
          layer.data[i * 4 + 2] = v;
          layer.data[i * 4 + 3] = 255;
        }
        renderer.flushLayer(layer);
        glLayersRef.current.set(maskId, layer);
        // No render here — the caller will trigger a render via dispatch
      },

      invalidate: () => {
        renderFromPlan();
      },

      copyCellRect: (srcX, srcY, dstX, dstY, cellW, cellH) => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        const canvasW = renderer.pixelWidth;
        const canvasH = renderer.pixelHeight;

        for (const layer of glLayersRef.current.values()) {
          // Grow layer to fit destination cell corners (no-op if already large enough)
          renderer.growLayerToFit(layer, dstX, dstY);
          renderer.growLayerToFit(
            layer,
            Math.min(canvasW - 1, dstX + cellW - 1),
            Math.min(canvasH - 1, dstY + cellH - 1),
          );

          const stride = layer.layerWidth;

          for (let dy = 0; dy < cellH; dy++) {
            const srcCy = srcY + dy;
            const dstCy = dstY + dy;
            if (dstCy < 0 || dstCy >= canvasH) continue;

            const dstLy = dstCy - layer.offsetY;
            if (dstLy < 0 || dstLy >= layer.layerHeight) continue;

            for (let dx = 0; dx < cellW; dx++) {
              const srcCx = srcX + dx;
              const dstCx = dstX + dx;
              if (dstCx < 0 || dstCx >= canvasW) continue;

              const dstLx = dstCx - layer.offsetX;
              if (dstLx < 0 || dstLx >= stride) continue;

              const srcLx = srcCx - layer.offsetX;
              const srcLy = srcCy - layer.offsetY;
              const srcInBounds =
                srcCx >= 0 &&
                srcCx < canvasW &&
                srcCy >= 0 &&
                srcCy < canvasH &&
                srcLx >= 0 &&
                srcLx < stride &&
                srcLy >= 0 &&
                srcLy < layer.layerHeight;

              if (layer.format === "indexed8") {
                const dstI = dstLy * stride + dstLx;
                (layer.data as Uint8Array)[dstI] = srcInBounds
                  ? (layer.data as Uint8Array)[srcLy * stride + srcLx]
                  : 255; // transparent sentinel
              } else {
                const dstI = (dstLy * stride + dstLx) * 4;
                if (srcInBounds) {
                  const srcI = (srcLy * stride + srcLx) * 4;
                  layer.data[dstI] = layer.data[srcI];
                  layer.data[dstI + 1] = layer.data[srcI + 1];
                  layer.data[dstI + 2] = layer.data[srcI + 2];
                  layer.data[dstI + 3] = layer.data[srcI + 3];
                } else {
                  layer.data[dstI] =
                    layer.data[dstI + 1] =
                    layer.data[dstI + 2] =
                    layer.data[dstI + 3] =
                      0;
                }
              }
            }
          }

          renderer.flushLayer(layer, swatchesRef.current as RGBAColor[]);
        }

        renderFromPlan();
      },
    }),
    [width, height, tiledMode],
  ); // eslint-disable-line react-hooks/exhaustive-deps
}
