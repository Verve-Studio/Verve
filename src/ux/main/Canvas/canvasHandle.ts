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

import { encodePng } from "./pngHelpers";
import {
  rasterizeDocument,
  type RasterBackend,
  type RasterReason,
} from "@/graphics/rasterization";
import { matchPaletteIndices } from "@/wasm";
import { activeScope } from "@/core/store/scope";

// ─── Public handle type (imported by App.tsx and other callers) ────────────

export interface CanvasHandle {
  /** Encode a layer's pixel data to a PNG data-URL synchronously. Returns layer-local PNG + geometry. */
  exportLayerPng: (
    layerId: string,
  ) => {
    png: string;
    layerWidth: number;
    layerHeight: number;
    offsetX: number;
    offsetY: number;
  } | null;
  /** Encode a baked adjustment mask to a PNG data-URL synchronously. */
  exportAdjustmentMaskPng: (layerId: string) => string | null;
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
    data: Uint8Array,
    lw?: number,
    lh?: number,
    ox?: number,
    oy?: number,
  ) => void;
  /** Zero out every pixel in a layer that is covered by the selection mask (canvas-space), then flush+render. */
  clearLayerPixels: (layerId: string, mask: Uint8Array) => void;
  /** Snapshot all current layers' raw pixel data + geometry for history. */
  captureAllLayerPixels: () => Map<string, Uint8Array | Float32Array>;
  /**
   * Snapshot per-layer contentVersion. Used by history capture to deduplicate
   * unchanged layers across entries (sharing buffer references) so a 10-layer
   * doc doesn't allocate 10× the per-entry RAM when only one layer changed.
   */
  captureAllLayerContentVersions: () => Map<string, number>;
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
  /** Snapshot baked selection masks for adjustment layers. */
  captureAllAdjustmentMasks: () => Map<string, Uint8Array>;
  /** Restore previously snapshotted pixel data + geometry and flush+render for each layer.
   * Pass layerStateForRender (the history snapshot's layer state) so the render uses the correct mask map. */
  restoreAllLayerPixels: (
    data: Map<string, Uint8Array | Float32Array>,
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
  restoreAllAdjustmentMasks: (masks: Map<string, Uint8Array>) => void;
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
  /**
   * Write a canvas-size RGBA pixel buffer into an existing layer, flush to GPU,
   * and re-render. `pixels` must be Uint8Array of length (canvasWidth × canvasHeight × 4),
   * the same format returned by `getLayerPixels`. Does NOT push to undo history.
   */
  writeLayerPixels: (layerId: string, pixels: Uint8Array) => void;
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
  /** Export raw Float32Array for an rgba32f layer. Returns null for non-f32 layers. */
  exportLayerF32: (layerId: string) => Float32Array | null;
  /** Export raw Uint8Array for an indexed8 layer. Returns null for non-indexed layers. */
  exportLayerIndexed: (layerId: string) => Uint8Array | null;
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

// ─── Hook ─────────────────────────────────────────────────────────────────────

interface UseCanvasHandleParams {
  ref: React.ForwardedRef<CanvasHandle>;
  rendererRef: { readonly current: WebGPURenderer | null };
  glLayersRef: { readonly current: Map<string, GpuLayer> };
  adjustmentMaskMap: { readonly current: Map<string, GpuLayer> };
  layersStateRef: { readonly current: readonly LayerState[] };
  swatchesRef: { readonly current: readonly RGBAColor[] };
  /** Returns the correctly-filtered layers + mask map + full render plan. */
  buildRenderArgs: () => {
    layers: GpuLayer[];
    maskMap: Map<string, GpuLayer>;
    plan: RenderPlanEntry[];
  };
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

export function useCanvasHandle({
  ref,
  rendererRef,
  glLayersRef,
  adjustmentMaskMap,
  layersStateRef,
  swatchesRef,
  buildRenderArgs,
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
      activeScope().adjustmentPreview.snapshot(),
      swatchesRef.current as RGBAColor[],
    );
  };

  useImperativeHandle(
    ref,
    () => ({
      exportLayerPng: (layerId) => {
        const renderer = rendererRef.current;
        const layer = glLayersRef.current.get(layerId);
        if (!renderer || !layer) return null;
        const raw = renderer.readLayerPixels(layer);
        const u8 =
          raw instanceof Float32Array
            ? new Uint8Array(raw.length).map((_, i) =>
                Math.round(Math.min(raw[i], 1) * 255),
              )
            : (raw as Uint8Array);
        const png = encodePng(u8, layer.layerWidth, layer.layerHeight);
        return {
          png,
          layerWidth: layer.layerWidth,
          layerHeight: layer.layerHeight,
          offsetX: layer.offsetX,
          offsetY: layer.offsetY,
        };
      },

      getLayerExportData: (layerId) => {
        const renderer = rendererRef.current;
        const layer = glLayersRef.current.get(layerId);
        if (!renderer || !layer) return null;
        const raw = renderer.readLayerPixels(layer);
        const u8 =
          raw instanceof Float32Array
            ? new Uint8Array(raw.length).map((_, i) =>
                Math.round(Math.min(raw[i], 1) * 255),
              )
            : (raw as Uint8Array);
        return {
          pixels: u8,
          width: layer.layerWidth,
          height: layer.layerHeight,
          offsetX: layer.offsetX,
          offsetY: layer.offsetY,
        };
      },

      exportAdjustmentMaskPng: (layerId) => {
        const renderer = rendererRef.current;
        const maskLayer = adjustmentMaskMap.current.get(layerId);
        if (!renderer || !maskLayer) return null;
        const raw = renderer.readLayerPixels(maskLayer);
        const u8 =
          raw instanceof Float32Array
            ? new Uint8Array(raw.length).map((_, i) =>
                Math.round(Math.min(raw[i], 1) * 255),
              )
            : (raw as Uint8Array);
        return encodePng(u8, renderer.pixelWidth, renderer.pixelHeight);
      },

      rasterizeComposite: async (reason) => {
        const renderer = requireRenderer();
        const { plan } = buildRenderArgsRef.current();
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
              result[di] = Math.round(Math.min(src[si], 1) * 255);
              result[di + 1] = Math.round(Math.min(src[si + 1], 1) * 255);
              result[di + 2] = Math.round(Math.min(src[si + 2], 1) * 255);
              result[di + 3] = Math.round(Math.min(src[si + 3], 1) * 255);
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

      prepareNewLayer: (layerId, name, data, lw?, lh?, ox?, oy?) => {
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
        );
        layer.data.set(data);
        renderer.flushLayer(layer);
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

      captureAllLayerContentVersions: () => {
        const result = new Map<string, number>();
        for (const ls of layersStateRef.current) {
          const layer = glLayersRef.current.get(ls.id);
          if (layer) result.set(ls.id, layer.contentVersion);
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

      captureAllAdjustmentMasks: () => {
        const result = new Map<string, Uint8Array>();
        for (const [layerId, maskLayer] of adjustmentMaskMap.current) {
          result.set(layerId, maskLayer.data.slice() as Uint8Array);
        }
        return result;
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
        for (const [id, pixels] of data) {
          const geo = geometry?.get(id);
          let layer = glLayersRef.current.get(id);
          const isF32 = (pixels as unknown) instanceof Float32Array;
          const isIndexed8 =
            !isF32 &&
            pixels.length !==
              (geo?.layerWidth ?? renderer.pixelWidth) *
                (geo?.layerHeight ?? renderer.pixelHeight) *
                4;
          const fmt = isF32 ? "rgba32f" : isIndexed8 ? "indexed8" : "rgba8";
          if (geo) {
            if (
              !layer ||
              layer.layerWidth !== geo.layerWidth ||
              layer.layerHeight !== geo.layerHeight ||
              layer.format !== fmt
            ) {
              if (layer) renderer.destroyLayer(layer);
              layer = renderer.createLayer(
                id,
                layer?.name ?? "Restored",
                geo.layerWidth,
                geo.layerHeight,
                geo.offsetX,
                geo.offsetY,
                fmt,
              );
              glLayersRef.current.set(id, layer);
            } else {
              layer.offsetX = geo.offsetX;
              layer.offsetY = geo.offsetY;
            }
          }
          if (!layer) {
            layer = renderer.createLayer(
              id,
              "Restored",
              renderer.pixelWidth,
              renderer.pixelHeight,
              0,
              0,
              fmt,
            );
            glLayersRef.current.set(id, layer);
          }
          layer.data.set(pixels as Uint8Array);
          renderer.flushLayer(
            layer,
            fmt === "indexed8"
              ? (swatchesRef.current as import("@/types").RGBAColor[])
              : undefined,
          );
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
        for (const [layerId, data] of masks) {
          let maskLayer = adjustmentMaskMap.current.get(layerId);
          if (!maskLayer) {
            maskLayer = renderer.createLayer(
              `${layerId}:adjustment-mask`,
              "Adjustment Mask",
              renderer.pixelWidth,
              renderer.pixelHeight,
              0,
              0,
            );
            adjustmentMaskMap.current.set(layerId, maskLayer);
          }
          maskLayer.data.set(data);
          renderer.flushLayer(maskLayer);
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

        for (let ly = 0; ly < layer.layerHeight; ly++) {
          const cy = layer.offsetY + ly;
          if (cy < 0 || cy >= h) continue;
          for (let lx = 0; lx < layer.layerWidth; lx++) {
            const cx = layer.offsetX + lx;
            if (cx < 0 || cx >= w) continue;
            const si = (cy * w + cx) * 4;
            const di = (ly * layer.layerWidth + lx) * 4;
            layer.data[di] = pixels[si];
            layer.data[di + 1] = pixels[si + 1];
            layer.data[di + 2] = pixels[si + 2];
            layer.data[di + 3] = pixels[si + 3];
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

      exportLayerF32: (layerId) => {
        const layer = glLayersRef.current.get(layerId);
        if (!layer || layer.format !== "rgba32f") return null;
        return (layer.data as Float32Array).slice();
      },

      exportLayerIndexed: (layerId) => {
        const layer = glLayersRef.current.get(layerId);
        if (!layer || layer.format !== "indexed8") return null;
        return (layer.data as Uint8Array).slice();
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
    [width, height],
  ); // eslint-disable-line react-hooks/exhaustive-deps
}
