import type { AppAction } from "@/core/store/AppContext";

import {
  computeInverseAffine,
  computeInverseHomography,
} from "@/core/tools/Transform/Transform";
import type { AppState, PixelFormat, RGBAColor } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { applyAffineTransform, applyPerspectiveTransform } from "@/wasm";
import {
  convertF32ToRgba8,
  convertIndexedToRgba8,
} from "@/utils/pixelFormatConvert";
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
//
// Free transform works in the layer's own format on canvas-sized buffers:
// RGBA bytes (rgba8), scene-linear float RGBA (rgba32f), or palette indices
// (indexed8). The resampler takes RGBA, so indices are packed into the red
// channel (alpha 0 = transparent) and resampled nearest-neighbour, which
// moves them without ever turning them into colours.

type Pixels = Uint8Array | Float32Array;

/** Is the pixel at canvas index `i` visible? */
function isVisible(px: Pixels, format: PixelFormat, i: number): boolean {
  return format === "indexed8" ? px[i] !== 255 : px[i * 4 + 3] > 0;
}

function findBoundingRect(
  pixels: Pixels,
  format: PixelFormat,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } {
  let minX = w,
    maxX = -1,
    minY = h,
    maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isVisible(pixels, format, y * w + x)) {
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

/** Crop `rect` out of a canvas-sized buffer as the resampler's RGBA input
 *  (indexed8 is packed: red = index, alpha 255 / 0). Unselected pixels are
 *  left transparent. */
function cropForTransform(
  src: Pixels,
  format: PixelFormat,
  srcW: number,
  rect: { x: number; y: number; w: number; h: number },
  mask: Uint8Array | null,
): Pixels {
  const { x, y, w, h } = rect;
  const out =
    format === "rgba32f" ? new Float32Array(w * h * 4) : new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const si = (y + row) * srcW + (x + col);
      if (mask !== null && mask[si] === 0) continue;
      const di = (row * w + col) * 4;
      if (format === "indexed8") {
        if (src[si] === 255) continue;
        out[di] = src[si];
        out[di + 3] = 255;
        continue;
      }
      out[di] = src[si * 4];
      out[di + 1] = src[si * 4 + 1];
      out[di + 2] = src[si * 4 + 2];
      out[di + 3] = src[si * 4 + 3];
    }
  }
  return out;
}

/** The transform input as sRGB bytes for the on-screen preview. */
function previewRgba(
  input: Pixels,
  format: PixelFormat,
  palette: readonly RGBAColor[],
): Uint8Array {
  if (format === "rgba32f") return convertF32ToRgba8(input as Float32Array);
  if (format === "indexed8") {
    const indices = new Uint8Array(input.length / 4);
    for (let i = 0; i < indices.length; i++) {
      indices[i] = input[i * 4 + 3] > 0 ? input[i * 4] : 255;
    }
    return convertIndexedToRgba8(indices, [...palette]);
  }
  return input as Uint8Array;
}

/**
 * Composite the canvas-sized resampler output `top` over `base` (the layer's
 * canvas data), in place on `base`. RGBA formats use straight-alpha
 * Porter-Duff "over"; indexed8 replaces pixels wherever `top` is opaque.
 */
function compositeOver(base: Pixels, top: Pixels, format: PixelFormat): void {
  if (format === "indexed8") {
    for (let p = 0; p < base.length; p++) {
      if (top[p * 4 + 3] > 0) base[p] = top[p * 4];
    }
    return;
  }
  const one = format === "rgba32f" ? 1 : 255;
  const round = format === "rgba32f" ? (v: number) => v : Math.round;
  for (let i = 0; i < top.length; i += 4) {
    const ta = top[i + 3];
    if (ta <= 0) continue;
    if (ta >= one) {
      base[i] = top[i];
      base[i + 1] = top[i + 1];
      base[i + 2] = top[i + 2];
      base[i + 3] = one;
      continue;
    }
    const sa = ta / one;
    const da = base[i + 3] / one;
    const oa = sa + da * (1 - sa);
    const k = da * (1 - sa);
    base[i] = round((top[i] * sa + base[i] * k) / oa);
    base[i + 1] = round((top[i + 1] * sa + base[i + 1] * k) / oa);
    base[i + 2] = round((top[i + 2] * sa + base[i + 2] * k) / oa);
    base[i + 3] = round(oa * one);
  }
}

/** An empty canvas-sized buffer in `format`. */
function emptyCanvas(format: PixelFormat, w: number, h: number): Pixels {
  if (format === "rgba32f") return new Float32Array(w * h * 4);
  if (format === "indexed8") return new Uint8Array(w * h).fill(255);
  return new Uint8Array(w * h * 4);
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
      pixelFormat,
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
      if (!layer) throw new Error("The layer no longer exists.");
      if (layer.format !== pixelFormat) {
        throw new Error("The layer's colour mode changed during the transform.");
      }
      // Indices can't be blended: indexed8 always resamples nearest.
      const interpInt = interpToInt(
        pixelFormat === "indexed8" ? "nearest" : interpolation,
      );

      let result: Pixels;
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
      const composed = handle.getLayerCanvasData(layerId);
      if (!composed) throw new Error("The layer no longer exists.");
      compositeOver(composed, result, pixelFormat);
      handle.writeLayerCanvasData(layerId, composed);

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
      handle.writeLayerCanvasData(tx.layerId, tx.savedLayerPixels);
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

    const gpu = handle.getGpuLayer(activeId);
    const pixels = handle.getLayerCanvasData(activeId);
    if (!gpu || !pixels) return;
    const format = gpu.format;

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

    const savedLayerPixels = pixels;
    let floatBuffer: Pixels;
    let rect: { x: number; y: number; w: number; h: number };
    let savedSelectionMask: Uint8Array | null = null;

    if (isSelectionMode) {
      const mask = activeScope().selection.mask!;
      rect = findMaskBoundingRect(mask, cw, ch);
      if (rect.w <= 0 || rect.h <= 0) return;
      floatBuffer = cropForTransform(pixels, format, cw, rect, mask);
      savedSelectionMask = mask.slice();
      handle.clearLayerPixels(activeId, mask);
    } else {
      rect = findBoundingRect(pixels, format, cw, ch);
      floatBuffer = cropForTransform(pixels, format, cw, rect, null);
      // Clear the layer so the WebGL composite doesn't show the original underneath the overlay preview
      handle.writeLayerCanvasData(activeId, emptyCanvas(format, cw, ch));
    }

    const { w: origW, h: origH } = rect;
    const floatCanvas = new OffscreenCanvas(origW, origH);
    const fc = floatCanvas.getContext("2d")!;
    fc.putImageData(
      new ImageData(
        new Uint8ClampedArray(previewRgba(floatBuffer, format, state.swatches)),
        origW,
        origH,
      ),
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
      pixelFormat: format,
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
