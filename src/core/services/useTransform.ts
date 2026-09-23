import type { AppAction } from "@/core/store/AppContext";

import {
  computeInverseAffine,
  computeInverseHomography,
} from "@/core/tools/Transform/Transform";
import type { AppState } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import {
  applyAffineTransform,
  applyPerspectiveTransform,
  matchPaletteIndices,
} from "@/wasm";
import type { Dispatch, MutableRefObject } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { activeScope } from "@/core/store/scope";
import { statusMessageStore } from "@/core/store/statusMessageStore";
import { notificationStore } from "@/core/store/notificationStore";
import { extractErrorMessage } from "@/utils/userFeedback";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseTransformOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  dispatch: Dispatch<AppAction>;
  captureHistory: (label: string) => void;
}

export interface UseTransformReturn {
  handleEnterTransform: () => void;
  /** Commit the transform and leave transform mode. Resolves true when the
   *  transform was committed (or none was active), false when it failed —
   *  the transform then stays open so the user can retry or cancel. */
  handleApply: () => Promise<boolean>;
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

/** Porter-Duff "over" of a canvas-sized RGBA8 `top` onto `base`, in place
 *  on `base` (straight alpha). */
function compositeOver(base: Uint8Array, top: Uint8Array): void {
  for (let i = 0; i < top.length; i += 4) {
    const ta = top[i + 3];
    if (ta === 0) continue;
    if (ta === 255) {
      base[i] = top[i];
      base[i + 1] = top[i + 1];
      base[i + 2] = top[i + 2];
      base[i + 3] = 255;
      continue;
    }
    const sa = ta / 255;
    const da = base[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    const k = da * (1 - sa);
    base[i] = Math.round((top[i] * sa + base[i] * k) / oa);
    base[i + 1] = Math.round((top[i + 1] * sa + base[i + 1] * k) / oa);
    base[i + 2] = Math.round((top[i + 2] * sa + base[i + 2] * k) / oa);
    base[i + 3] = Math.round(oa * 255);
  }
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
  const applyingRef = useRef(false);

  const handleApply = useCallback(async (): Promise<boolean> => {
    const tx = activeScope().transform;
    if (!tx.isActive) return true;
    // Enter + button + guard dialog can all fire; one commit at a time.
    if (applyingRef.current) return false;
    const handle = canvasHandleRef.current;
    if (!handle) return false;

    const {
      params,
      handleMode,
      interpolation,
      floatBuffer,
      originalW,
      originalH,
      layerId,
      previousTool,
      isSelectionMode,
    } = tx;
    const { width: cw, height: ch } = stateRef.current.canvas;
    if (!floatBuffer) return false;

    applyingRef.current = true;
    try {
      const layer = handle.getGpuLayer(layerId);
      const isIndexed = layer?.format === "indexed8";
      const interpInt = interpToInt(isIndexed ? "nearest" : interpolation);

      let result: Uint8Array;
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

      // The transform may have been cancelled / the tab switched while the
      // WASM call ran — don't commit into a document that moved on.
      if (activeScope().transform !== tx || !tx.isActive) return false;

      // `result` holds only the transformed content. Composite it over what
      // is left of the layer (the rest of the layer outside a selection;
      // nothing in whole-layer mode) — writing `result` alone erased
      // everything outside the transformed selection.
      const composed = handle.getLayerPixels(layerId);
      if (!composed) throw new Error("The layer no longer exists.");
      compositeOver(composed, result);

      if (isIndexed) {
        const indexResult = await matchPaletteIndices(
          composed,
          stateRef.current.swatches,
          255,
        );
        handle.writeLayerIndexData(layerId, indexResult);
      } else {
        handle.writeLayerPixels(layerId, composed);
      }

      // A selection-mode transform moves the selection with the pixels.
      if (isSelectionMode) {
        const mask = new Uint8Array(cw * ch);
        for (let p = 0, q = 3; p < mask.length; p++, q += 4) {
          if (result[q] > 0) mask[p] = 255;
        }
        activeScope().selection.replaceMask(mask);
      }

      // Leave transform mode: the handles disappearing (plus the status
      // message) is the confirmation that the transform was applied. Ctrl+T
      // starts a new one on the committed pixels.
      tx.clear();
      dispatch({ type: "SET_TOOL", payload: previousTool });
      captureHistory("Free Transform");
      statusMessageStore.show("Transform applied");
      return true;
    } catch (err) {
      console.error("[useTransform] apply failed:", err);
      notificationStore.error(
        `Could not apply the transform: ${extractErrorMessage(err)}`,
      );
      return false;
    } finally {
      applyingRef.current = false;
    }
  }, [canvasHandleRef, stateRef, dispatch, captureHistory]);

  const handleCancel = useCallback((): void => {
    if (!activeScope().transform.isActive) return;
    const handle = canvasHandleRef.current;

    const tx = activeScope().transform;
    if (handle && tx.savedLayerPixels) {
      handle.writeLayerPixels(tx.layerId, tx.savedLayerPixels);
    }
    if (tx.savedSelectionMask) {
      activeScope().selection.restoreMask(tx.savedSelectionMask);
    }

    dispatch({ type: "SET_TOOL", payload: tx.previousTool });
    tx.clear();
    statusMessageStore.show("Transform cancelled");
  }, [canvasHandleRef, dispatch]);

  const handleEnterTransform = useCallback((): void => {
    if (activeScope().transform.isActive) return;
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

    const hasMask = activeScope().selection.mask !== null;
    const maskHasArea =
      hasMask &&
      (() => {
        const m = activeScope().selection.mask!;
        for (let i = 0; i < m.length; i++) if (m[i] > 0) return true;
        return false;
      })();

    const isSelectionMode = hasMask && maskHasArea;

    const savedLayerPixels = pixels.slice();
    let floatBuffer: Uint8Array;
    let rect: { x: number; y: number; w: number; h: number };
    let savedSelectionMask: Uint8Array | null = null;

    if (isSelectionMode) {
      const mask = activeScope().selection.mask!;
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

    activeScope().transform.onApply = () => void handleApply();
    activeScope().transform.onCancel = handleCancel;

    activeScope().transform.enter({
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
      if (!activeScope().transform.isActive) return;
      // A dialog (e.g. "Transform in Progress") owns the keyboard.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const inField =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement;
      if (e.key === "Enter") {
        // In a numeric field Enter commits that field (it blurs itself);
        // the next Enter applies the transform.
        if (inField) return;
        e.preventDefault();
        void handleApply();
      } else if (e.key === "Escape") {
        // Escape always cancels, even from a field.
        e.preventDefault();
        if (inField) (e.target as HTMLElement).blur();
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
