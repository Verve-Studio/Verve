import type { AppAction } from "@/core/store/AppContext";
import { selectionStore } from "@/core/store/selectionStore";
import { transformStore } from "@/core/store/transformStore";
import {
  computeInverseAffine,
  computeInverseHomography,
} from "@/tools/Transform/Transform";
import type { AppState } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import {
  applyAffineTransform,
  applyPerspectiveTransform,
  matchPaletteIndices,
} from "@/wasm";
import type { Dispatch, MutableRefObject } from "react";
import { useCallback, useEffect, useMemo } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseTransformOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  dispatch: Dispatch<AppAction>;
  captureHistory: (label: string) => void;
}

export interface UseTransformReturn {
  handleEnterTransform: () => void;
  handleApply: () => void;
  handleCancel: () => void;
  isFreeTransformEnabled: boolean;
}

// ─── Pixel utilities ──────────────────────────────────────────────────────────

function findBoundingRect(
  pixels: Uint8Array,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } {
  let minX = w,
    maxX = -1,
    minY = h,
    maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (pixels[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w, h };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function findMaskBoundingRect(
  mask: Uint8Array,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } {
  let minX = w,
    maxX = -1,
    minY = h,
    maxY = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] > 0) {
      const x = i % w,
        y = Math.floor(i / w);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w, h };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function cropPixels(
  src: Uint8Array,
  srcW: number,
  rect: { x: number; y: number; w: number; h: number },
  mask: Uint8Array | null,
): Uint8Array {
  const { x, y, w, h } = rect;
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const sx = x + col,
        sy = y + row;
      const srcIdx = (sy * srcW + sx) * 4;
      const dstIdx = (row * w + col) * 4;
      if (mask !== null && mask[sy * srcW + sx] === 0) {
        out[dstIdx] = out[dstIdx + 1] = out[dstIdx + 2] = out[dstIdx + 3] = 0;
      } else {
        out[dstIdx] = src[srcIdx];
        out[dstIdx + 1] = src[srcIdx + 1];
        out[dstIdx + 2] = src[srcIdx + 2];
        out[dstIdx + 3] = src[srcIdx + 3];
      }
    }
  }
  return out;
}

function interpToInt(interp: string): number {
  if (interp === "nearest") return 0;
  if (interp === "bicubic") return 2;
  return 1;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useTransform({
  canvasHandleRef,
  stateRef,
  dispatch,
  captureHistory,
}: UseTransformOptions): UseTransformReturn {
  const handleApply = useCallback(async (): Promise<void> => {
    if (!transformStore.isActive) return;
    const handle = canvasHandleRef.current;
    if (!handle) return;

    const {
      params,
      handleMode,
      interpolation,
      floatBuffer,
      originalW,
      originalH,
      layerId,
    } = transformStore;
    const { canvas } = stateRef.current;
    const { width: cw, height: ch } = canvas;
    if (!floatBuffer) return;

    const layer = handle.getGpuLayer(layerId);
    const isIndexed = layer?.format === "indexed8";
    const effectiveInterp = isIndexed ? "nearest" : interpolation;
    const interpInt = interpToInt(effectiveInterp);
    let result: Uint8Array;

    try {
      if (handleMode === "perspective" && params.perspectiveCorners) {
        const srcQuad: [
          { x: number; y: number },
          { x: number; y: number },
          { x: number; y: number },
          { x: number; y: number },
        ] = [
          { x: 0, y: 0 },
          { x: originalW, y: 0 },
          { x: originalW, y: originalH },
          { x: 0, y: originalH },
        ];
        const invH = computeInverseHomography(
          srcQuad,
          params.perspectiveCorners,
        );
        result = await applyPerspectiveTransform(
          floatBuffer,
          originalW,
          originalH,
          cw,
          ch,
          invH,
          interpInt,
        );
      } else {
        const invMatrix = computeInverseAffine(params, originalW, originalH);
        result = await applyAffineTransform(
          floatBuffer,
          originalW,
          originalH,
          cw,
          ch,
          invMatrix,
          interpInt,
        );
      }
    } catch (err) {
      console.error("[useTransform] WASM transform failed:", err);
      return;
    }

    if (isIndexed) {
      const swatches = stateRef.current.swatches;
      const indexResult = await matchPaletteIndices(result, swatches, 255);
      handle.writeLayerIndexData(layerId, indexResult);
    } else {
      handle.writeLayerPixels(layerId, result);
    }
    captureHistory("Free Transform");

    // Stay on the transform tool with a fresh baseline so the user can chain
    // transformations. Re-bootstrap the store from the just-committed pixels.
    const committedPixels = handle.getLayerPixels(layerId);
    const previousTool = transformStore.previousTool;
    const wasSelectionMode = transformStore.isSelectionMode;
    const savedSelectionMask = transformStore.savedSelectionMask;

    if (!committedPixels) {
      dispatch({ type: "SET_TOOL", payload: previousTool });
      transformStore.clear();
      return;
    }

    let nextRect: { x: number; y: number; w: number; h: number };
    let nextFloatBuffer: Uint8Array;
    if (wasSelectionMode && savedSelectionMask) {
      // After applying a selection-mode transform, the selection itself moved
      // to wherever the user dragged it. Re-fit on the committed pixels' bbox.
      nextRect = findBoundingRect(committedPixels, cw, ch);
      if (nextRect.w <= 0 || nextRect.h <= 0) {
        dispatch({ type: "SET_TOOL", payload: previousTool });
        transformStore.clear();
        return;
      }
      nextFloatBuffer = cropPixels(committedPixels, cw, nextRect, null);
    } else {
      nextRect = findBoundingRect(committedPixels, cw, ch);
      if (nextRect.w <= 0 || nextRect.h <= 0) {
        dispatch({ type: "SET_TOOL", payload: previousTool });
        transformStore.clear();
        return;
      }
      nextFloatBuffer = cropPixels(committedPixels, cw, nextRect, null);
    }

    const { w: nW, h: nH } = nextRect;
    const nextFloatCanvas = new OffscreenCanvas(nW, nH);
    const nfc = nextFloatCanvas.getContext("2d")!;
    nfc.putImageData(
      new ImageData(new Uint8ClampedArray(nextFloatBuffer), nW, nH),
      0,
      0,
    );

    const nextSavedLayerPixels = committedPixels.slice();

    // Clear the layer so the WebGL composite doesn't show the committed pixels
    // underneath the next overlay preview (mirrors the initial-entry behavior).
    handle.writeLayerPixels(layerId, new Uint8Array(cw * ch * 4));

    transformStore.enter({
      layerId,
      previousTool,
      isSelectionMode: false,
      originalW: nW,
      originalH: nH,
      originalRect: nextRect,
      floatBuffer: nextFloatBuffer,
      floatCanvas: nextFloatCanvas,
      savedLayerPixels: nextSavedLayerPixels,
      savedSelectionMask: null,
      params: {
        x: nextRect.x,
        y: nextRect.y,
        w: nW,
        h: nH,
        rotation: 0,
        pivotX: nextRect.x + nW / 2,
        pivotY: nextRect.y + nH / 2,
        shearX: 0,
        shearY: 0,
        perspectiveCorners: null,
      },
    });
  }, [canvasHandleRef, stateRef, dispatch, captureHistory]);

  const handleCancel = useCallback((): void => {
    if (!transformStore.isActive) return;
    const handle = canvasHandleRef.current;

    if (handle && transformStore.savedLayerPixels) {
      handle.writeLayerPixels(
        transformStore.layerId,
        transformStore.savedLayerPixels,
      );
    }
    if (transformStore.savedSelectionMask) {
      selectionStore.restoreMask(transformStore.savedSelectionMask);
    }

    dispatch({ type: "SET_TOOL", payload: transformStore.previousTool });
    transformStore.clear();
  }, [canvasHandleRef, dispatch]);

  const handleEnterTransform = useCallback((): void => {
    if (transformStore.isActive) return;
    const handle = canvasHandleRef.current;
    if (!handle) return;

    const state = stateRef.current;
    const activeId = state.activeLayerId;
    if (!activeId) return;

    const layer = state.layers.find((l) => l.id === activeId);
    if (!layer || "type" in layer) return; // only plain pixel layers

    const pixels = handle.getLayerPixels(activeId);
    if (!pixels) return;

    const { canvas } = state;
    const cw = canvas.width,
      ch = canvas.height;

    const hasMask = selectionStore.mask !== null;
    const maskHasArea =
      hasMask &&
      (() => {
        const m = selectionStore.mask!;
        for (let i = 0; i < m.length; i++) if (m[i] > 0) return true;
        return false;
      })();

    const isSelectionMode = hasMask && maskHasArea;

    const savedLayerPixels = pixels.slice();
    let floatBuffer: Uint8Array;
    let rect: { x: number; y: number; w: number; h: number };
    let savedSelectionMask: Uint8Array | null = null;

    if (isSelectionMode) {
      const mask = selectionStore.mask!;
      rect = findMaskBoundingRect(mask, cw, ch);
      if (rect.w <= 0 || rect.h <= 0) return;
      floatBuffer = cropPixels(pixels, cw, rect, mask);
      savedSelectionMask = mask.slice();
      handle.clearLayerPixels(activeId, mask);
    } else {
      rect = findBoundingRect(pixels, cw, ch);
      floatBuffer = cropPixels(pixels, cw, rect, null);
      // Clear the layer so the WebGL composite doesn't show the original underneath the overlay preview
      handle.writeLayerPixels(activeId, new Uint8Array(cw * ch * 4));
    }

    const { w: origW, h: origH } = rect;
    const floatCanvas = new OffscreenCanvas(origW, origH);
    const fc = floatCanvas.getContext("2d")!;
    fc.putImageData(
      new ImageData(new Uint8ClampedArray(floatBuffer), origW, origH),
      0,
      0,
    );

    const params = {
      x: rect.x,
      y: rect.y,
      w: origW,
      h: origH,
      rotation: 0,
      pivotX: rect.x + origW / 2,
      pivotY: rect.y + origH / 2,
      shearX: 0,
      shearY: 0,
      perspectiveCorners: null as null,
    };

    transformStore.onApply = handleApply;
    transformStore.onCancel = handleCancel;

    transformStore.enter({
      layerId: activeId,
      previousTool: state.activeTool,
      isSelectionMode,
      originalW: origW,
      originalH: origH,
      originalRect: rect,
      floatBuffer,
      floatCanvas,
      savedLayerPixels,
      savedSelectionMask,
      params,
    });

    dispatch({ type: "SET_TOOL", payload: "transform" });
  }, [canvasHandleRef, stateRef, dispatch, handleApply, handleCancel]);

  // Keyboard Enter/Escape while transform is active
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!transformStore.isActive) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (e.key === "Enter") {
        e.preventDefault();
        handleApply();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [handleApply, handleCancel]);

  const isFreeTransformEnabled = useMemo((): boolean => {
    if (stateRef.current.activeTool === "transform") return false;
    const state = stateRef.current;
    const layer = state.layers.find((l) => l.id === state.activeLayerId);
    if (!layer) return false;
    return !("type" in layer); // only plain pixel layers
  }, [
    stateRef.current.activeLayerId,
    stateRef.current.layers,
    stateRef.current.activeTool,
  ]);

  return {
    handleEnterTransform,
    handleApply,
    handleCancel,
    isFreeTransformEnabled,
  };
}
