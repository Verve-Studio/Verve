import type { AppAction } from "@/core/store/AppContext";
import type { ClipboardData } from "@/core/store/clipboardStore";
import { clipboardStore } from "@/core/store/clipboardStore";

import { makeTabId } from "@/core/store/tabTypes";
import type { AppState } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { Dispatch, MutableRefObject } from "react";
import { useCallback } from "react";
import { activeScope } from "@/core/store/scope";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseClipboardOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  state: AppState;
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

/** Encode an RGBA Uint8Array as a base64 PNG string using an OffscreenCanvas. */
async function encodePng(
  data: Uint8Array,
  width: number,
  height: number,
): Promise<string> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(data), width, height),
    0,
    0,
  );
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

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

/** Decode a base64 PNG string to an RGBA Uint8Array. */
async function decodePng(
  base64: string,
): Promise<{ data: Uint8Array; width: number; height: number } | null> {
  try {
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++)
      bytes[i] = binaryStr.charCodeAt(i);
    const blob = new Blob([bytes], { type: "image/png" });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      data: new Uint8Array(imageData.data.buffer),
      width: bitmap.width,
      height: bitmap.height,
    };
  } catch {
    return null;
  }
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
  void encodePng(bboxData, bboxW, bboxH)
    .then((b64) => window.api.clipboardWriteImage(b64))
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
        const pngBase64 = await window.api.clipboardReadImage();
        if (pngBase64) {
          const decoded = await decodePng(pngBase64);
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
      canvasHandleRef.current?.prepareNewLayer(
        newId,
        "Paste",
        srcData,
        srcW,
        srcH,
        offsetX,
        offsetY,
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
        const pngBase64 = await window.api.clipboardReadImage();
        if (pngBase64) {
          const decoded = await decodePng(pngBase64);
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

      canvasHandleRef.current?.prepareNewLayer(
        newId,
        "Paste Into",
        srcData,
        srcW,
        srcH,
        pasteX,
        pasteY,
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
