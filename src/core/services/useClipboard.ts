import type { AppShellState } from "@/core/store/AppContext";
import type { AppAction } from "@/core/store/AppContext";
import type { ClipboardData } from "@/core/store/clipboardStore";
import { clipboardStore } from "@/core/store/clipboardStore";

import { makeTabId } from "@/core/store/tabTypes";
import { convertRgba8ToF32 } from "@/utils/pixelFormatConvert";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { Dispatch, MutableRefObject } from "react";
import { useCallback } from "react";
import { activeScope } from "@/core/store/scope";
import {
  bgraPremulToRgba,
  rgbaToBgraPremul,
} from "@/core/io/clipboardBitmap";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseClipboardOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  state: AppShellState;
  dispatch: Dispatch<AppAction>;
  captureHistory: (label: string) => void;
  pendingLayerLabelRef: MutableRefObject<string | null>;
}

export interface UseClipboardReturn {
  handleCopy: () => void;
  handleCopyMerged: () => void;
  handleCut: () => void;
  handlePaste: () => void;
  handlePasteInto: () => void;
  handleDelete: () => void;
}

// ─── System clipboard helpers ─────────────────────────────────────────────────

/** Return the bounding box (top-left x/y) of non-zero pixels in a canvas-sized selection mask. */
function selectionBounds(
  mask: Uint8Array,
  width: number,
  height: number,
): { x: number; y: number } | null {
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX >= 0 ? { x: minX, y: minY } : null;
}

/** The system clipboard image as straight RGBA, or null. */
async function readSystemClipboardImage(): Promise<{
  data: Uint8Array;
  width: number;
  height: number;
} | null> {
  const bmp = await window.api.clipboardReadImage();
  if (!bmp || bmp.data.byteLength !== bmp.width * bmp.height * 4) return null;
  return {
    data: bgraPremulToRgba(bmp.data),
    width: bmp.width,
    height: bmp.height,
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/** Crop to tight bounding box, write to internal store and system clipboard. */
function writeToClipboard(
  pixels: Uint8Array,
  width: number,
  height: number,
): void {
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return;

  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;
  const bboxData = new Uint8Array(bboxW * bboxH * 4);
  for (let y = 0; y < bboxH; y++) {
    for (let x = 0; x < bboxW; x++) {
      const si = ((minY + y) * width + (minX + x)) * 4;
      const di = (y * bboxW + x) * 4;
      bboxData[di] = pixels[si];
      bboxData[di + 1] = pixels[si + 1];
      bboxData[di + 2] = pixels[si + 2];
      bboxData[di + 3] = pixels[si + 3];
    }
  }
  clipboardStore.current = {
    data: bboxData,
    width: bboxW,
    height: bboxH,
    offsetX: minX,
    offsetY: minY,
  };
  void window.api
    .clipboardWriteImage(rgbaToBgraPremul(bboxData), bboxW, bboxH)
    .catch(() => {
      /* system clipboard write is best-effort */
    });
}

export function useClipboard({
  canvasHandleRef,
  state,
  dispatch,
  captureHistory,
  pendingLayerLabelRef,
}: UseClipboardOptions): UseClipboardReturn {
  const handleCopy = useCallback((): void => {
    const activeId = state.activeLayerId;
    if (!activeId) return;
    const pixels = canvasHandleRef.current?.getLayerPixels(activeId);
    if (!pixels) return;
    const { width, height } = state.canvas;

    // Apply selection mask: scale alpha by selection strength (supports feathered edges)
    const mask = activeScope().selection.mask;
    if (mask) {
      for (let i = 0; i < mask.length; i++) {
        pixels[i * 4 + 3] = Math.round((pixels[i * 4 + 3] * mask[i]) / 255);
      }
    }

    writeToClipboard(pixels, width, height);
  }, [state.activeLayerId, state.canvas, canvasHandleRef]);

  const handleCut = useCallback((): void => {
    const activeId = state.activeLayerId;
    if (!activeId) return;
    // Text and shape layers are parametric — pixel erasure is nonsensical and gets overwritten
    const layerMeta = state.layers.find((l) => l.id === activeId);
    if (layerMeta && "type" in layerMeta) return;
    handleCopy();
    const totalPixels = state.canvas.width * state.canvas.height;
    const mask = activeScope().selection.mask ?? new Uint8Array(totalPixels).fill(255);
    canvasHandleRef.current?.clearLayerPixels(activeId, mask);
    captureHistory("Cut");
  }, [
    state.activeLayerId,
    state.layers,
    state.canvas,
    handleCopy,
    captureHistory,
    canvasHandleRef,
  ]);

  const handleDelete = useCallback((): void => {
    const activeId = state.activeLayerId;
    if (!activeId) return;
    // Text and shape layers are parametric — pixel erasure is nonsensical and gets overwritten
    const layerMeta = state.layers.find((l) => l.id === activeId);
    if (layerMeta && "type" in layerMeta) return;
    const totalPixels = state.canvas.width * state.canvas.height;
    const mask = activeScope().selection.mask ?? new Uint8Array(totalPixels).fill(255);
    canvasHandleRef.current?.clearLayerPixels(activeId, mask);
    captureHistory("Delete");
  }, [
    state.activeLayerId,
    state.layers,
    state.canvas,
    captureHistory,
    canvasHandleRef,
  ]);

  const handlePaste = useCallback((): void => {
    void (async () => {
      const { width: dstW, height: dstH } = state.canvas;

      // Prefer the system clipboard so images copied from other apps can be pasted.
      let clipData: ClipboardData | null = null;
      try {
        {
          const decoded = await readSystemClipboardImage();
          if (decoded) {
            const { data, width: srcW, height: srcH } = decoded;
            const internal = clipboardStore.current;
            if (
              internal &&
              internal.width === srcW &&
              internal.height === srcH
            ) {
              // Same dimensions as internal store → came from this session's copy;
              // reuse stored offset so the paste lands back at its original position.
              clipData = internal;
            } else {
              // Image came from another app (or different dimensions) — paste centred.
              clipData = {
                data,
                width: srcW,
                height: srcH,
                offsetX: Math.floor((dstW - srcW) / 2),
                offsetY: Math.floor((dstH - srcH) / 2),
              };
            }
          }
        }
      } catch {
        // System clipboard read unavailable; fall through to internal store.
      }

      if (!clipData) clipData = clipboardStore.current;
      if (!clipData) return;

      const {
        data: srcData,
        width: srcW,
        height: srcH,
        offsetX,
        offsetY,
      } = clipData;
      const newId = makeTabId();
      // Clipboard data is always RGBA8 bytes. In an f32 doc convert to
      // Float32 (matching the codebase's `convertRgba8ToF32` convention)
      // and pass the matching format so the layer is allocated as f32.
      const docFormat = state.pixelFormat;
      const pasteData =
        docFormat === "rgba32f" ? convertRgba8ToF32(srcData) : srcData;
      canvasHandleRef.current?.prepareNewLayer(
        newId,
        "Paste",
        pasteData,
        srcW,
        srcH,
        offsetX,
        offsetY,
        docFormat,
      );
      pendingLayerLabelRef.current = "Paste";
      dispatch({
        type: "ADD_LAYER",
        payload: {
          id: newId,
          name: "Paste",
          visible: true,
          opacity: 1,
          locked: false,
          blendMode: "normal",
        },
      });
    })();
  }, [state.canvas, dispatch, canvasHandleRef, pendingLayerLabelRef]);

  const handleCopyMerged = useCallback((): void => {
    void (async () => {
      const { width, height } = state.canvas;
      const result =
        await canvasHandleRef.current?.rasterizeComposite("sample");
      if (!result) return;
      // Normalize f32→u8 for rgba32f documents; rgba8/indexed8 are already Uint8Array
      const rgba =
        result.data instanceof Float32Array
          ? new Uint8Array(
              result.data.map((v) =>
                Math.round(Math.min(1, Math.max(0, v)) * 255),
              ),
            )
          : (result.data as Uint8Array);
      writeToClipboard(rgba, width, height);
    })();
  }, [state.canvas, canvasHandleRef]);

  const handlePasteInto = useCallback((): void => {
    const sourceMask = activeScope().selection.mask;
    if (!sourceMask) return; // no-op without an active selection
    const selMask = sourceMask.slice(); // snapshot before async
    void (async () => {
      const { width: dstW, height: dstH } = state.canvas;

      // Resolve clipboard — same logic as handlePaste
      let clipData: ClipboardData | null = null;
      try {
        {
          const decoded = await readSystemClipboardImage();
          if (decoded) {
            const { data, width: srcW, height: srcH } = decoded;
            const internal = clipboardStore.current;
            if (
              internal &&
              internal.width === srcW &&
              internal.height === srcH
            ) {
              clipData = internal;
            } else {
              clipData = {
                data,
                width: srcW,
                height: srcH,
                offsetX: Math.floor((dstW - srcW) / 2),
                offsetY: Math.floor((dstH - srcH) / 2),
              };
            }
          }
        }
      } catch {
        /* fall through */
      }
      if (!clipData) clipData = clipboardStore.current;
      if (!clipData) return;

      const {
        data: srcData,
        width: srcW,
        height: srcH,
        offsetX,
        offsetY,
      } = clipData;
      // Position the layer at the selection's top-left corner so that the pasted
      // content's origin aligns with the origin of the selection bounding box.
      const bounds = selectionBounds(selMask, dstW, dstH);
      const pasteX = bounds ? bounds.x : offsetX;
      const pasteY = bounds ? bounds.y : offsetY;
      const newId = makeTabId();
      const maskId = makeTabId();

      // Same Uint8 → Float32 conversion as the regular Paste path so the
      // pasted layer lands correctly in an f32 document.
      const docFormat = state.pixelFormat;
      const pasteData =
        docFormat === "rgba32f" ? convertRgba8ToF32(srcData) : srcData;
      canvasHandleRef.current?.prepareNewLayer(
        newId,
        "Paste Into",
        pasteData,
        srcW,
        srcH,
        pasteX,
        pasteY,
        docFormat,
      );
      canvasHandleRef.current?.prepareMaskLayer(maskId, "Layer Mask", selMask);

      pendingLayerLabelRef.current = "Paste Into";
      dispatch({
        type: "ADD_LAYER",
        payload: {
          id: newId,
          name: "Paste Into",
          visible: true,
          opacity: 1,
          locked: false,
          blendMode: "normal",
        },
      });
      dispatch({
        type: "ADD_MASK_LAYER",
        payload: {
          id: maskId,
          name: "Layer Mask",
          visible: true,
          type: "mask",
          parentId: newId,
        },
      });
    })();
  }, [state.canvas, dispatch, canvasHandleRef, pendingLayerLabelRef]);

  return {
    handleCopy,
    handleCopyMerged,
    handleCut,
    handlePaste,
    handlePasteInto,
    handleDelete,
  };
}
