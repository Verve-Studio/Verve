import type { AppAction } from "@/core/store/AppContext";

import {
  f32TransferStore,
  u8TransferStore,
} from "@/core/store/layerDataTransfer";
import type { TabRecord } from "@/core/store/tabTypes";
import type { AppState } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { ResizeCanvasSettings } from "@/ux/modals/ResizeCanvasDialog/ResizeCanvasDialog";
import type { ResizeImageSettings } from "@/ux/modals/ResizeImageDialog/ResizeImageDialog";
import type { RescaleImageSettings } from "@/ux/modals/RescaleImageDialog/RescaleImageDialog";
import type { RestoreImageSettings } from "@/ux/modals/RestoreImageDialog/RestoreImageDialog";
import {
  clipLayerToCanvas,
  resampleLayer,
  toCanvasSized,
  type LayerBuffer,
} from "@/utils/layerPixelTransforms";
import {
  flipIndexed,
  flipRgba,
  rotateIndexed,
  rotateRgba,
} from "@/wasm";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useEffect } from "react";
import { activeScope } from "@/core/store/scope";
import { notificationStore } from "@/core/store/notificationStore";
import { showOperationError } from "@/utils/userFeedback";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RescaleProgress {
  /** 1-based index of the layer currently running through the model. */
  layerIdx: number;
  /** Total number of layers to process this run. */
  layerCount: number;
  /** Tiles processed in the current layer. */
  tilesLoaded: number;
  /** Total tile count for the current layer. */
  tilesTotal: number;
  /** Verb shown in the progress overlay — e.g. "Rescaling", "Restoring". */
  label: "Rescaling" | "Restoring";
}

interface UseCanvasTransformsOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  captureHistory: (label: string) => void;
  dispatch: Dispatch<AppAction>;
  activeTabId: string;
  /** Live active-tab id, read after awaits to detect a tab switch. */
  activeTabIdRef: { readonly current: string };
  setTabs: Dispatch<SetStateAction<TabRecord[]>>;
  setPendingLayerData: Dispatch<SetStateAction<Map<string, string> | null>>;
  pendingLayerLabelRef: MutableRefObject<string | null>;
  canvasWidth: number;
  canvasHeight: number;
  /** Toggle to true while AI rescale is running so MainWindow can render
   *  the blocking progress scrim. */
  setRescaling?: Dispatch<SetStateAction<boolean>>;
  /** Per-tile progress for the active rescale layer. */
  setRescaleProgress?: Dispatch<SetStateAction<RescaleProgress>>;
}

export type RotateAmount = "90cw" | "180" | "270cw";
export type FlipAxis = "horizontal" | "vertical";

/** How a transform is invoked. The menu / dialog path reports failures to
 *  the user; programmatic callers (automation) pass `throwErrors` to get
 *  them as exceptions instead. */
export interface TransformCallOptions {
  throwErrors?: boolean;
}

/** Layer transforms: explicit targets (default: selected + active layers). */
export interface LayerTransformCallOptions extends TransformCallOptions {
  layerIds?: readonly string[];
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UseCanvasTransformsReturn {
  handleResizeImage: (settings: ResizeImageSettings, opts?: TransformCallOptions) => Promise<void>;
  handleRescaleImage: (settings: RescaleImageSettings, opts?: TransformCallOptions) => Promise<void>;
  handleRestoreImage: (settings: RestoreImageSettings, opts?: TransformCallOptions) => Promise<void>;
  handleResizeCanvas: (settings: ResizeCanvasSettings, opts?: TransformCallOptions) => void;
  /** Crop to `rect` (canvas pixels), or to the Crop tool's rectangle. */
  handleCrop: (rect?: CropRect, opts?: TransformCallOptions) => void;
  handleRotate: (amount: RotateAmount, opts?: TransformCallOptions) => Promise<void>;
  handleFlip: (axis: FlipAxis, opts?: TransformCallOptions) => Promise<void>;
  handleRotateSelectedLayers: (amount: RotateAmount, opts?: LayerTransformCallOptions) => Promise<void>;
  handleFlipSelectedLayers: (axis: FlipAxis, opts?: LayerTransformCallOptions) => Promise<void>;
}

// ─── Layer-local helpers ──────────────────────────────────────────────────────

function rotateF32(
  src: Float32Array,
  srcW: number,
  srcH: number,
  amount: 0 | 1 | 2,
): { data: Float32Array; dstW: number; dstH: number } {
  const dstW = amount === 1 ? srcW : srcH;
  const dstH = amount === 1 ? srcH : srcW;
  const dst = new Float32Array(dstW * dstH * 4);
  for (let sy = 0; sy < srcH; sy++) {
    for (let sx = 0; sx < srcW; sx++) {
      let dx: number, dy: number;
      if (amount === 0) {
        dx = srcH - 1 - sy;
        dy = sx;
      } else if (amount === 1) {
        dx = srcW - 1 - sx;
        dy = srcH - 1 - sy;
      } else {
        dx = sy;
        dy = srcW - 1 - sx;
      }
      const si = (sy * srcW + sx) * 4;
      const di = (dy * dstW + dx) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
  return { data: dst, dstW, dstH };
}

function flipF32(
  src: Float32Array,
  w: number,
  h: number,
  axis: 0 | 1,
): Float32Array {
  const dst = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = axis === 0 ? w - 1 - x : x;
      const dy = axis === 1 ? h - 1 - y : y;
      const si = (y * w + x) * 4;
      const di = (dy * w + dx) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
  return dst;
}

type LayerGeo = {
  layerWidth: number;
  layerHeight: number;
  offsetX: number;
  offsetY: number;
};

/**
 * Where a layer-local rect lands after rotating the whole canvas (W×H).
 * Matches `rotateF32`'s mapping: amount 0 = 90° CW, 1 = 180°, 2 = 270° CW.
 */
function rotatedGeo(geo: LayerGeo, W: number, H: number, amount: 0 | 1 | 2): LayerGeo {
  const { layerWidth: lw, layerHeight: lh, offsetX: ox, offsetY: oy } = geo;
  if (amount === 0) {
    return { layerWidth: lh, layerHeight: lw, offsetX: H - oy - lh, offsetY: ox };
  }
  if (amount === 1) {
    return { layerWidth: lw, layerHeight: lh, offsetX: W - ox - lw, offsetY: H - oy - lh };
  }
  return { layerWidth: lh, layerHeight: lw, offsetX: oy, offsetY: W - ox - lw };
}

/** Where a layer-local rect lands after flipping the whole canvas (W×H). */
function flippedGeo(geo: LayerGeo, W: number, H: number, axis: 0 | 1): LayerGeo {
  return axis === 0
    ? { ...geo, offsetX: W - geo.offsetX - geo.layerWidth }
    : { ...geo, offsetY: H - geo.offsetY - geo.layerHeight };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useCanvasTransforms({
  canvasHandleRef,
  stateRef,
  captureHistory,
  dispatch,
  activeTabId,
  setTabs,
  setPendingLayerData,
  pendingLayerLabelRef,
  canvasWidth,
  canvasHeight,
  setRescaling,
  setRescaleProgress,
  activeTabIdRef,
}: UseCanvasTransformsOptions): UseCanvasTransformsReturn {
  // Transfer-store keys for this tab's transform results. Prefixed so they
  // can't collide with another tab's layer ids (every document has a
  // "layer-0") or with this tab's own backgrounded pixels (`${tabId}:${id}`).
  const xformPrefix = `${activeTabId}:xform:`;

  /**
   * Async transforms (AI rescale/restore can take minutes) must not apply
   * their result to whichever tab happens to be active when they finish.
   * If the user switched tabs meanwhile, drop the results and tell them.
   */
  const abandonedAfterTabSwitch = useCallback(
    (startTabId: string, what: string): boolean => {
      if (activeTabIdRef.current === startTabId) return false;
      f32TransferStore.dropPrefix(`${startTabId}:xform:`);
      u8TransferStore.dropPrefix(`${startTabId}:xform:`);
      notificationStore.error(
        `${what} was cancelled because a different document became active while it was running.`,
      );
      return true;
    },
    [activeTabIdRef],
  );

  /**
   * Every layer's pixel buffer in its own format and layer-local space
   * (rgba32f floats, indexed8 palette indices, rgba8 bytes), plus baked
   * effect-layer selection masks (canvas-sized rgba8), for a canvas
   * dimension transform. Buffers are live views: transforms must copy.
   */
  const collectLayerBuffers = useCallback(
    (handle: CanvasHandle): { id: string; mask: boolean; buf: LayerBuffer }[] => {
      const out: { id: string; mask: boolean; buf: LayerBuffer }[] = [];
      const oldW = canvasWidth;
      const oldH = canvasHeight;
      for (const layer of stateRef.current.layers) {
        if ("type" in layer && layer.type === "adjustment") {
          if (!layer.hasMask) continue;
          const mask = handle.getAdjustmentMaskPixels(layer.id);
          if (!(mask instanceof Uint8Array) || mask.length !== oldW * oldH * 4) continue;
          out.push({
            id: layer.id,
            mask: true,
            buf: { data: mask, format: "rgba8", width: oldW, height: oldH, offsetX: 0, offsetY: 0 },
          });
          continue;
        }
        const gpu = handle.getGpuLayer(layer.id);
        if (!gpu) continue;
        out.push({
          id: layer.id,
          mask: false,
          buf: {
            data: gpu.data,
            format: gpu.format,
            width: gpu.layerWidth,
            height: gpu.layerHeight,
            offsetX: gpu.offsetX,
            offsetY: gpu.offsetY,
          },
        });
      }
      return out;
    },
    [canvasWidth, canvasHeight, stateRef],
  );

  /** Encode transformed buffers for the remounted canvas: transfer-store
   *  refs in each layer's format plus its new geometry. */
  const encodeLayerBuffers = useCallback(
    (
      results: readonly { id: string; mask: boolean; buf: LayerBuffer }[],
      newW: number,
      newH: number,
    ): Map<string, string> => {
      const encoded = new Map<string, string>();
      for (const { id, mask, buf } of results) {
        if (mask) {
          const key = `${xformPrefix}${id}:adjustment-mask`;
          u8TransferStore.set(key, toCanvasSized(buf, newW, newH));
          encoded.set(`${id}:adjustment-mask`, `data:raw/rgba8-ref;id=${key}`);
          continue;
        }
        const key = xformPrefix + id;
        if (buf.format === "rgba32f") {
          f32TransferStore.set(key, buf.data as Float32Array);
          encoded.set(id, `data:raw/f32-ref;id=${key}`);
        } else {
          u8TransferStore.set(key, buf.data as Uint8Array);
          encoded.set(id, `data:raw/${buf.format === "indexed8" ? "indexed8" : "rgba8"}-ref;id=${key}`);
        }
        encoded.set(
          `${id}:geo`,
          JSON.stringify({
            layerWidth: buf.width,
            layerHeight: buf.height,
            offsetX: buf.offsetX,
            offsetY: buf.offsetY,
          }),
        );
      }
      return encoded;
    },
    [xformPrefix],
  );

  const handleResizeImage = useCallback(
    async (settings: ResizeImageSettings, opts?: TransformCallOptions): Promise<void> => {
      const { width: newW, height: newH, filter } = settings;
      const oldW = canvasWidth;
      const oldH = canvasHeight;
      if (newW === oldW && newH === oldH) return;
      const handle = canvasHandleRef.current;
      if (!handle) {
        if (opts?.throwErrors) throw new Error("The canvas isn't ready yet.");
        return;
      }
      try {
        // Each layer is resampled natively in its own format (see
        // `resampleLayer`): floats stay scene-linear, indices stay indices.
        const results = await Promise.all(
          collectLayerBuffers(handle).map(async (e) => ({
            ...e,
            buf: await resampleLayer(e.buf, oldW, oldH, newW, newH, filter),
          })),
        );
        const encoded = encodeLayerBuffers(results, newW, newH);
        if (abandonedAfterTabSwitch(activeTabId, "Resize Image")) return;
        captureHistory("Before Resize Image");
        const resizeTabId = activeTabId;
        setTabs((prev) =>
          prev.map((t) =>
            t.id === resizeTabId
              ? {
                  ...t,
                  canvasKey: t.canvasKey + 1,
                  snapshot: {
                    ...t.snapshot,
                    canvasWidth: newW,
                    canvasHeight: newH,
                  },
                }
              : t,
          ),
        );
        setPendingLayerData(encoded);
        pendingLayerLabelRef.current = "Resize Image";
        dispatch({
          type: "RESIZE_CANVAS",
          payload: { width: newW, height: newH },
        });
      } catch (err) {
        if (opts?.throwErrors) throw err;
        console.error("[Resize] Failed to resize image:", err);
        showOperationError("Resize Image failed.", err);
      }
    },
    [
      collectLayerBuffers,
      encodeLayerBuffers,
      canvasWidth,
      canvasHeight,
      canvasHandleRef,
      stateRef,
      captureHistory,
      abandonedAfterTabSwitch,
      xformPrefix,
      activeTabId,
      setTabs,
      setPendingLayerData,
      pendingLayerLabelRef,
      dispatch,
    ],
  );

  const handleRescaleImage = useCallback(
    async (settings: RescaleImageSettings, opts?: TransformCallOptions): Promise<void> => {
      const { width: newW, height: newH, modelId } = settings;
      const oldW = canvasWidth;
      const oldH = canvasHeight;
      if (newW === oldW && newH === oldH) return;
      const handle = canvasHandleRef.current;
      if (!handle) {
        if (opts?.throwErrors) throw new Error("The canvas isn't ready yet.");
        return;
      }
      const { pixelFormat } = stateRef.current;
      if (pixelFormat !== "rgba8") {
        console.warn(
          "[Rescale] AI rescale only supported for rgba8 documents, got",
          pixelFormat,
        );
        return;
      }
      // Filter to the layers we'll actually feed into the model so the
      // progress numerator/denominator matches what the user sees moving.
      const eligibleLayers = stateRef.current.layers.filter(
        (l) => handle.getLayerPixels(l.id) !== null,
      );
      setRescaling?.(true);
      setRescaleProgress?.({
        layerIdx: 0,
        layerCount: eligibleLayers.length,
        tilesLoaded: 0,
        tilesTotal: 0,
        label: "Rescaling",
      });
      // Tile-level progress events arrive from the main process while a
      // single layer is in flight. We rebroadcast them as updates to the
      // current layer's tile counters; the layer index is bumped on the
      // renderer side because the IPC channel doesn't carry it.
      const unsubProgress = window.api.upscale.onProgress((p) => {
        setRescaleProgress?.((prev) => ({
          ...prev,
          tilesLoaded: p.loaded,
          tilesTotal: p.total,
        }));
      });
      try {
        const encoded = new Map<string, string>();
        for (let i = 0; i < eligibleLayers.length; i++) {
          const layer = eligibleLayers[i];
          const pixels = handle.getLayerPixels(layer.id);
          if (!pixels) continue;
          setRescaleProgress?.((prev) => ({
            ...prev,
            layerIdx: i + 1,
            tilesLoaded: 0,
            tilesTotal: 0,
          }));
          // Skip empty layers — running a model on a fully transparent
          // tile burns time and the alpha-bilinear path already produces
          // the right zeros for free via the resize fallback.
          let hasOpaque = false;
          for (let p = 3; p < pixels.length; p += 4) {
            if (pixels[p] > 0) { hasOpaque = true; break }
          }
          let resized: Uint8Array;
          if (!hasOpaque) {
            resized = new Uint8Array(newW * newH * 4);
          } else {
            const result = await window.api.upscale.run({
              rgba: pixels,
              width: oldW,
              height: oldH,
              modelId,
              targetWidth: newW,
              targetHeight: newH,
            });
            resized = result.rgba;
          }
          u8TransferStore.set(xformPrefix + layer.id, resized);
          encoded.set(layer.id, `data:raw/rgba8-ref;id=${xformPrefix}${layer.id}`);
        }
        if (abandonedAfterTabSwitch(activeTabId, "Rescale Image")) return;
        captureHistory("Before Rescale Image");
        const rescaleTabId = activeTabId;
        setTabs((prev) =>
          prev.map((t) =>
            t.id === rescaleTabId
              ? {
                  ...t,
                  canvasKey: t.canvasKey + 1,
                  snapshot: {
                    ...t.snapshot,
                    canvasWidth: newW,
                    canvasHeight: newH,
                  },
                }
              : t,
          ),
        );
        setPendingLayerData(encoded);
        pendingLayerLabelRef.current = "Rescale Image";
        dispatch({
          type: "RESIZE_CANVAS",
          payload: { width: newW, height: newH },
        });
      } catch (err) {
        if (opts?.throwErrors) throw err;
        console.error("[Rescale] Failed to rescale image:", err);
        showOperationError("AI Rescale failed.", err);
      } finally {
        unsubProgress();
        setRescaling?.(false);
      }
    },
    [
      canvasWidth,
      canvasHeight,
      canvasHandleRef,
      stateRef,
      captureHistory,
      abandonedAfterTabSwitch,
      xformPrefix,
      activeTabId,
      setTabs,
      setPendingLayerData,
      pendingLayerLabelRef,
      dispatch,
      setRescaling,
      setRescaleProgress,
    ],
  );

  const handleRestoreImage = useCallback(
    async (settings: RestoreImageSettings, opts?: TransformCallOptions): Promise<void> => {
      const { modelId } = settings;
      const W = canvasWidth;
      const H = canvasHeight;
      const handle = canvasHandleRef.current;
      if (!handle) {
        if (opts?.throwErrors) throw new Error("The canvas isn't ready yet.");
        return;
      }
      const { pixelFormat } = stateRef.current;
      if (pixelFormat !== "rgba8") {
        console.warn(
          "[Restore] AI restore only supported for rgba8 documents, got",
          pixelFormat,
        );
        return;
      }
      const eligibleLayers = stateRef.current.layers.filter(
        (l) => handle.getLayerPixels(l.id) !== null,
      );
      setRescaling?.(true);
      setRescaleProgress?.({
        layerIdx: 0,
        layerCount: eligibleLayers.length,
        tilesLoaded: 0,
        tilesTotal: 0,
        label: "Restoring",
      });
      const unsubProgress = window.api.upscale.onProgress((p) => {
        setRescaleProgress?.((prev) => ({
          ...prev,
          tilesLoaded: p.loaded,
          tilesTotal: p.total,
        }));
      });
      try {
        const encoded = new Map<string, string>();
        for (let i = 0; i < eligibleLayers.length; i++) {
          const layer = eligibleLayers[i];
          const pixels = handle.getLayerPixels(layer.id);
          if (!pixels) continue;
          setRescaleProgress?.((prev) => ({
            ...prev,
            layerIdx: i + 1,
            tilesLoaded: 0,
            tilesTotal: 0,
          }));
          let hasOpaque = false;
          for (let p = 3; p < pixels.length; p += 4) {
            if (pixels[p] > 0) { hasOpaque = true; break }
          }
          // Fully-transparent layers carry no signal to restore.
          if (!hasOpaque) continue;
          const result = await window.api.upscale.run({
            rgba: pixels,
            width: W,
            height: H,
            modelId,
            targetWidth: W,
            targetHeight: H,
          });
          u8TransferStore.set(xformPrefix + layer.id, result.rgba);
          encoded.set(layer.id, `data:raw/rgba8-ref;id=${xformPrefix}${layer.id}`);
        }
        if (encoded.size === 0) return;
        if (abandonedAfterTabSwitch(activeTabId, "Restore Image")) return;
        captureHistory("Before Restore Image");
        const restoreTabId = activeTabId;
        // No snapshot or dimension change — restore returns pixels at the
        // source resolution. The canvasKey bump just forces a remount so
        // pendingLayerData is consumed.
        setTabs((prev) =>
          prev.map((t) =>
            t.id === restoreTabId
              ? { ...t, canvasKey: t.canvasKey + 1 }
              : t,
          ),
        );
        setPendingLayerData(encoded);
        pendingLayerLabelRef.current = "Restore Image";
      } catch (err) {
        if (opts?.throwErrors) throw err;
        console.error("[Restore] Failed to restore image:", err);
        showOperationError("AI Restore failed.", err);
      } finally {
        unsubProgress();
        setRescaling?.(false);
      }
    },
    [
      canvasWidth,
      canvasHeight,
      canvasHandleRef,
      stateRef,
      captureHistory,
      abandonedAfterTabSwitch,
      xformPrefix,
      activeTabId,
      setTabs,
      setPendingLayerData,
      pendingLayerLabelRef,
      setRescaling,
      setRescaleProgress,
    ],
  );

  const handleResizeCanvas = useCallback(
    (settings: ResizeCanvasSettings, opts?: TransformCallOptions): void => {
      const { width: newW, height: newH, anchorCol, anchorRow } = settings;
      const oldW = canvasWidth;
      const oldH = canvasHeight;
      if (newW === oldW && newH === oldH) return;
      const handle = canvasHandleRef.current;
      if (!handle) {
        if (opts?.throwErrors) throw new Error("The canvas isn't ready yet.");
        return;
      }

      const offsetX =
        anchorCol === 0
          ? 0
          : anchorCol === 1
            ? Math.round((newW - oldW) / 2)
            : newW - oldW;
      const offsetY =
        anchorRow === 0
          ? 0
          : anchorRow === 1
            ? Math.round((newH - oldH) / 2)
            : newH - oldH;

      // Each layer moves by the anchor offset and is clipped to the new
      // canvas in its own format.
      const encoded = encodeLayerBuffers(
        collectLayerBuffers(handle).map((e) => ({
          ...e,
          buf: clipLayerToCanvas(e.buf, offsetX, offsetY, newW, newH),
        })),
        newW,
        newH,
      );

      captureHistory("Before Resize Canvas");
      const resizeCanvasTabId = activeTabId;
      setTabs((prev) =>
        prev.map((t) =>
          t.id === resizeCanvasTabId
            ? {
                ...t,
                canvasKey: t.canvasKey + 1,
                snapshot: {
                  ...t.snapshot,
                  canvasWidth: newW,
                  canvasHeight: newH,
                },
              }
            : t,
        ),
      );
      setPendingLayerData(encoded);
      pendingLayerLabelRef.current = "Resize Canvas";
      dispatch({
        type: "RESIZE_CANVAS",
        payload: { width: newW, height: newH },
      });
    },
    [
      collectLayerBuffers,
      encodeLayerBuffers,
      canvasWidth,
      canvasHeight,
      canvasHandleRef,
      stateRef,
      captureHistory,
      abandonedAfterTabSwitch,
      xformPrefix,
      activeTabId,
      setTabs,
      setPendingLayerData,
      pendingLayerLabelRef,
      dispatch,
    ],
  );

  const handleCrop = useCallback((rect?: CropRect, opts?: TransformCallOptions): void => {
    const r = rect ?? activeScope().crop.rect;
    if (!r) {
      if (opts?.throwErrors) throw new Error("No crop rectangle.");
      return;
    }
    const oldW = canvasWidth;
    const oldH = canvasHeight;
    const cropX = Math.max(0, r.x);
    const cropY = Math.max(0, r.y);
    const cropW = Math.min(r.w, oldW - cropX);
    const cropH = Math.min(r.h, oldH - cropY);
    if (cropW <= 0 || cropH <= 0) {
      if (opts?.throwErrors) throw new Error("The crop rectangle is outside the canvas.");
      return;
    }
    const handle = canvasHandleRef.current;
    if (!handle) {
      if (opts?.throwErrors) throw new Error("The canvas isn't ready yet.");
      return;
    }

    // Each layer moves by the crop origin and is clipped to the crop size
    // in its own format.
    const encoded = encodeLayerBuffers(
      collectLayerBuffers(handle).map((e) => ({
        ...e,
        buf: clipLayerToCanvas(e.buf, -cropX, -cropY, cropW, cropH),
      })),
      cropW,
      cropH,
    );

    activeScope().crop.clear();
    captureHistory("Before Crop");
    const cropTabId = activeTabId;
    setTabs((prev) =>
      prev.map((t) =>
        t.id === cropTabId
          ? {
              ...t,
              canvasKey: t.canvasKey + 1,
              snapshot: {
                ...t.snapshot,
                canvasWidth: cropW,
                canvasHeight: cropH,
              },
            }
          : t,
      ),
    );
    setPendingLayerData(encoded);
    pendingLayerLabelRef.current = "Crop";
    dispatch({
      type: "RESIZE_CANVAS",
      payload: { width: cropW, height: cropH },
    });
  }, [
    collectLayerBuffers,
    encodeLayerBuffers,
    canvasWidth,
    canvasHeight,
    canvasHandleRef,
    stateRef,
    captureHistory,
    xformPrefix,
    activeTabId,
    setTabs,
    setPendingLayerData,
    pendingLayerLabelRef,
    dispatch,
  ]);

  useEffect(() => {
    activeScope().crop.onCrop = () => handleCrop();
    return () => {
      activeScope().crop.onCrop = null;
    };
  }, [handleCrop]);

  const handleRotate = useCallback(
    async (amount: RotateAmount, opts?: LayerTransformCallOptions): Promise<void> => {
      const handle = canvasHandleRef.current;
      if (!handle) {
        if (opts?.throwErrors) throw new Error("The canvas isn't ready yet.");
        return;
      }
      const startTabId = activeTabIdRef.current;
      const oldW = canvasWidth;
      const oldH = canvasHeight;
      const { layers, pixelFormat } = stateRef.current;
      const isIndexed = pixelFormat === "indexed8";
      const newW = amount === "180" ? oldW : oldH;
      const newH = amount === "180" ? oldH : oldW;
      const wasmAmount: 0 | 1 | 2 =
        amount === "90cw" ? 0 : amount === "180" ? 1 : 2;
      // rgba32f layers are stored layer-local (not canvas-sized), so they're
      // rotated in their own space and their offset is remapped.
      const layerGeo = handle.captureAllLayerGeometry();
      const geoEntries: [string, string][] = [];

      try {
        const entries = await Promise.all(
          layers.map(async (layer): Promise<[string, string] | null> => {
            if (isIndexed) {
              const srcIdx = handle.getLayerIndexData(layer.id);
              if (!srcIdx) return null;
              const dst = await rotateIndexed(srcIdx, oldW, oldH, wasmAmount);
              u8TransferStore.set(xformPrefix + layer.id, dst);
              return [layer.id, `data:raw/indexed8-ref;id=${xformPrefix}${layer.id}`];
            } else if (stateRef.current.pixelFormat === "rgba32f") {
              const raw = handle.getLayerRawData(layer.id);
              if (!raw) return null;
              const geo = layerGeo.get(layer.id) ?? {
                layerWidth: oldW,
                layerHeight: oldH,
                offsetX: 0,
                offsetY: 0,
              };
              const { data } = rotateF32(
                raw as Float32Array,
                geo.layerWidth,
                geo.layerHeight,
                wasmAmount,
              );
              f32TransferStore.set(xformPrefix + layer.id, data);
              geoEntries.push([
                `${layer.id}:geo`,
                JSON.stringify(rotatedGeo(geo, oldW, oldH, wasmAmount)),
              ]);
              return [layer.id, `data:raw/f32-ref;id=${xformPrefix}${layer.id}`];
            } else {
              const src = handle.getLayerPixels(layer.id);
              if (!src) return null;
              const rotated = await rotateRgba(src, oldW, oldH, wasmAmount);
              u8TransferStore.set(xformPrefix + layer.id, rotated);
              return [layer.id, `data:raw/rgba8-ref;id=${xformPrefix}${layer.id}`];
            }
          }),
        );
        const encoded = new Map([
          ...entries.filter((e): e is [string, string] => e !== null),
          ...geoEntries,
        ]);

        const label =
          amount === "90cw"
            ? "Rotate 90° CW"
            : amount === "270cw"
              ? "Rotate 270° CW"
              : "Rotate 180°";
        if (abandonedAfterTabSwitch(startTabId, label)) return;
        captureHistory(`Before ${label}`);
        const tabId = activeTabId;
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  canvasKey: t.canvasKey + 1,
                  snapshot: {
                    ...t.snapshot,
                    canvasWidth: newW,
                    canvasHeight: newH,
                  },
                }
              : t,
          ),
        );
        setPendingLayerData(encoded);
        pendingLayerLabelRef.current = label;
        if (amount !== "180") {
          dispatch({
            type: "RESIZE_CANVAS",
            payload: { width: newW, height: newH },
          });
        }
      } catch (err) {
        if (opts?.throwErrors) throw err;
        console.error("[Rotate] Failed:", err);
        showOperationError("Rotate failed.", err);
      }
    },
    [
      canvasWidth,
      canvasHeight,
      canvasHandleRef,
      stateRef,
      captureHistory,
      abandonedAfterTabSwitch,
      xformPrefix,
      activeTabId,
      setTabs,
      setPendingLayerData,
      pendingLayerLabelRef,
      dispatch,
    ],
  );

  const handleFlip = useCallback(
    async (axis: FlipAxis, opts?: LayerTransformCallOptions): Promise<void> => {
      const handle = canvasHandleRef.current;
      if (!handle) {
        if (opts?.throwErrors) throw new Error("The canvas isn't ready yet.");
        return;
      }
      const startTabId = activeTabIdRef.current;
      const w = canvasWidth;
      const h = canvasHeight;
      const { layers, pixelFormat } = stateRef.current;
      const isIndexed = pixelFormat === "indexed8";
      const wasmAxis: 0 | 1 = axis === "horizontal" ? 0 : 1;
      // rgba32f layers are stored layer-local (not canvas-sized), so they're
      // flipped in their own space and their offset is mirrored.
      const layerGeo = handle.captureAllLayerGeometry();
      const geoEntries: [string, string][] = [];

      try {
        const entries = await Promise.all(
          layers.map(async (layer): Promise<[string, string] | null> => {
            if (isIndexed) {
              const srcIdx = handle.getLayerIndexData(layer.id);
              if (!srcIdx) return null;
              const dst = await flipIndexed(srcIdx, w, h, wasmAxis);
              u8TransferStore.set(xformPrefix + layer.id, dst);
              return [layer.id, `data:raw/indexed8-ref;id=${xformPrefix}${layer.id}`];
            } else if (stateRef.current.pixelFormat === "rgba32f") {
              const raw = handle.getLayerRawData(layer.id);
              if (!raw) return null;
              const geo = layerGeo.get(layer.id) ?? {
                layerWidth: w,
                layerHeight: h,
                offsetX: 0,
                offsetY: 0,
              };
              const data = flipF32(
                raw as Float32Array,
                geo.layerWidth,
                geo.layerHeight,
                wasmAxis,
              );
              f32TransferStore.set(xformPrefix + layer.id, data);
              geoEntries.push([
                `${layer.id}:geo`,
                JSON.stringify(flippedGeo(geo, w, h, wasmAxis)),
              ]);
              return [layer.id, `data:raw/f32-ref;id=${xformPrefix}${layer.id}`];
            } else {
              const src = handle.getLayerPixels(layer.id);
              if (!src) return null;
              const flipped = await flipRgba(src, w, h, wasmAxis);
              u8TransferStore.set(xformPrefix + layer.id, flipped);
              return [layer.id, `data:raw/rgba8-ref;id=${xformPrefix}${layer.id}`];
            }
          }),
        );
        const encoded = new Map([
          ...entries.filter((e): e is [string, string] => e !== null),
          ...geoEntries,
        ]);

        const label =
          axis === "horizontal" ? "Flip Horizontal" : "Flip Vertical";
        if (abandonedAfterTabSwitch(startTabId, label)) return;
        captureHistory(`Before ${label}`);
        const tabId = activeTabId;
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId ? { ...t, canvasKey: t.canvasKey + 1 } : t,
          ),
        );
        setPendingLayerData(encoded);
        pendingLayerLabelRef.current = label;
      } catch (err) {
        if (opts?.throwErrors) throw err;
        console.error("[Flip] Failed:", err);
        showOperationError("Flip failed.", err);
      }
    },
    [
      canvasWidth,
      canvasHeight,
      canvasHandleRef,
      stateRef,
      captureHistory,
      abandonedAfterTabSwitch,
      xformPrefix,
      activeTabId,
      setTabs,
      setPendingLayerData,
      pendingLayerLabelRef,
    ],
  );

  const handleRotateSelectedLayers = useCallback(
    async (amount: RotateAmount, opts?: LayerTransformCallOptions): Promise<void> => {
      const handle = canvasHandleRef.current;
      if (!handle) {
        if (opts?.throwErrors) throw new Error("The canvas isn't ready yet.");
        return;
      }
      const startTabId = activeTabIdRef.current;
      const { layers, selectedLayerIds, activeLayerId, swatches } =
        stateRef.current;
      const effectiveIds = new Set(opts?.layerIds ?? selectedLayerIds);
      if (activeLayerId && !opts?.layerIds) effectiveIds.add(activeLayerId);
      const wasmAmount: 0 | 1 | 2 =
        amount === "90cw" ? 0 : amount === "180" ? 1 : 2;
      try {
        type Op = {
          id: string;
          data: Uint8Array | Float32Array;
          newW: number;
          newH: number;
          fmt: import("@/types").PixelFormat;
        };
        const ops = (
          await Promise.all(
            layers
              .filter((l) => effectiveIds.has(l.id))
              .map(async (layer): Promise<Op | null> => {
                const gpuLayer = handle.getGpuLayer(layer.id);
                if (!gpuLayer) return null;
                const lw = gpuLayer.layerWidth,
                  lh = gpuLayer.layerHeight;
                const raw = handle.getLayerRawData(layer.id);
                if (!raw) return null;
                if (gpuLayer.format === "indexed8") {
                  const result = await rotateIndexed(
                    raw as Uint8Array,
                    lw,
                    lh,
                    wasmAmount,
                  );
                  return {
                    id: layer.id,
                    data: result,
                    newW: amount === "180" ? lw : lh,
                    newH: amount === "180" ? lh : lw,
                    fmt: "indexed8",
                  };
                } else if (gpuLayer.format === "rgba32f") {
                  const { data, dstW, dstH } = rotateF32(
                    raw as Float32Array,
                    lw,
                    lh,
                    wasmAmount,
                  );
                  return {
                    id: layer.id,
                    data,
                    newW: dstW,
                    newH: dstH,
                    fmt: "rgba32f",
                  };
                } else {
                  const result = await rotateRgba(
                    raw as Uint8Array,
                    lw,
                    lh,
                    wasmAmount,
                  );
                  return {
                    id: layer.id,
                    data: result,
                    newW: amount === "180" ? lw : lh,
                    newH: amount === "180" ? lh : lw,
                    fmt: "rgba8",
                  };
                }
              }),
          )
        ).filter((op): op is Op => op !== null);
        if (ops.length === 0) return;
        const label =
          amount === "90cw"
            ? "Rotate Layer 90° CW"
            : amount === "270cw"
              ? "Rotate Layer 270° CW"
              : "Rotate Layer 180°";
        if (abandonedAfterTabSwitch(startTabId, label)) return;
        captureHistory(`Before ${label}`);
        for (const op of ops) {
          const gpuLayer = handle.getGpuLayer(op.id);
          if (!gpuLayer) continue;
          gpuLayer.layerWidth = op.newW;
          gpuLayer.layerHeight = op.newH;
          handle.replaceLayerData(
            op.id,
            op.data,
            op.fmt,
            op.fmt === "indexed8"
              ? (swatches as import("@/types").RGBAColor[])
              : undefined,
          );
        }
      } catch (err) {
        if (opts?.throwErrors) throw err;
        console.error("[RotateLayer] Failed:", err);
        showOperationError("Rotate Layer failed.", err);
      }
    },
    [canvasHandleRef, stateRef, captureHistory, activeTabIdRef, abandonedAfterTabSwitch],
  );

  const handleFlipSelectedLayers = useCallback(
    async (axis: FlipAxis, opts?: LayerTransformCallOptions): Promise<void> => {
      const handle = canvasHandleRef.current;
      if (!handle) {
        if (opts?.throwErrors) throw new Error("The canvas isn't ready yet.");
        return;
      }
      const startTabId = activeTabIdRef.current;
      const { layers, selectedLayerIds, activeLayerId, swatches } =
        stateRef.current;
      const effectiveIds = new Set(opts?.layerIds ?? selectedLayerIds);
      if (activeLayerId && !opts?.layerIds) effectiveIds.add(activeLayerId);
      const wasmAxis: 0 | 1 = axis === "horizontal" ? 0 : 1;
      try {
        type Op = {
          id: string;
          data: Uint8Array | Float32Array;
          fmt: import("@/types").PixelFormat;
        };
        const ops = (
          await Promise.all(
            layers
              .filter((l) => effectiveIds.has(l.id))
              .map(async (layer): Promise<Op | null> => {
                const gpuLayer = handle.getGpuLayer(layer.id);
                if (!gpuLayer) return null;
                const lw = gpuLayer.layerWidth,
                  lh = gpuLayer.layerHeight;
                const raw = handle.getLayerRawData(layer.id);
                if (!raw) return null;
                if (gpuLayer.format === "indexed8") {
                  const result = await flipIndexed(
                    raw as Uint8Array,
                    lw,
                    lh,
                    wasmAxis,
                  );
                  return { id: layer.id, data: result, fmt: "indexed8" };
                } else if (gpuLayer.format === "rgba32f") {
                  return {
                    id: layer.id,
                    data: flipF32(raw as Float32Array, lw, lh, wasmAxis),
                    fmt: "rgba32f",
                  };
                } else {
                  const result = await flipRgba(
                    raw as Uint8Array,
                    lw,
                    lh,
                    wasmAxis,
                  );
                  return { id: layer.id, data: result, fmt: "rgba8" };
                }
              }),
          )
        ).filter((op): op is Op => op !== null);
        if (ops.length === 0) return;
        const label =
          axis === "horizontal"
            ? "Flip Layer Horizontal"
            : "Flip Layer Vertical";
        if (abandonedAfterTabSwitch(startTabId, label)) return;
        captureHistory(`Before ${label}`);
        for (const op of ops) {
          handle.replaceLayerData(
            op.id,
            op.data,
            op.fmt,
            op.fmt === "indexed8"
              ? (swatches as import("@/types").RGBAColor[])
              : undefined,
          );
        }
      } catch (err) {
        if (opts?.throwErrors) throw err;
        console.error("[FlipLayer] Failed:", err);
        showOperationError("Flip Layer failed.", err);
      }
    },
    [canvasHandleRef, stateRef, captureHistory, activeTabIdRef, abandonedAfterTabSwitch],
  );

  return {
    handleResizeImage,
    handleRescaleImage,
    handleRestoreImage,
    handleResizeCanvas,
    handleCrop,
    handleRotate,
    handleFlip,
    handleRotateSelectedLayers,
    handleFlipSelectedLayers,
  };
}
