import type { AppShellState } from "@/core/store/AppContext";
import type { AppAction } from "@/core/store/AppContext";
import type { ClipboardData } from "@/core/store/clipboardStore";
import { clipboardStore } from "@/core/store/clipboardStore";

import { makeTabId } from "@/core/store/tabTypes";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import {
  clipboardToFormat,
  clipboardToRgba8,
  cropToClipboard,
} from "@/core/io/clipboardPixels";
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

/** Store `clip` internally (native format) and write its 8-bit sRGB view to
 *  the system clipboard for other apps. */
function writeToClipboard(clip: ClipboardData | null): void {
  if (!clip) return;
  clipboardStore.current = clip;
  void window.api
    .clipboardWriteImage(
      rgbaToBgraPremul(clipboardToRgba8(clip)),
      clip.width,
      clip.height,
    )
    .catch(() => {
      /* system clipboard write is best-effort */
    });
}

/** The clipboard to paste: the internal one (native format) when the system
 *  clipboard still holds our copy, else the system image centred. */
async function resolveClipboard(
  canvasWidth: number,
  canvasHeight: number,
): Promise<ClipboardData | null> {
  const internal = clipboardStore.current;
  try {
    const decoded = await readSystemClipboardImage();
    if (decoded) {
      const { data, width: srcW, height: srcH } = decoded;
      // Same dimensions as the internal store → came from this session's
      // copy; reuse it (lossless, original position).
      if (internal && internal.width === srcW && internal.height === srcH) {
        return internal;
      }
      // Image came from another app (or different dimensions) — paste centred.
      return {
        format: "rgba8",
        data,
        width: srcW,
        height: srcH,
        offsetX: Math.floor((canvasWidth - srcW) / 2),
        offsetY: Math.floor((canvasHeight - srcH) / 2),
      };
    }
  } catch {
    // System clipboard read unavailable; fall through to internal store.
  }
  return internal;
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
    const layer = canvasHandleRef.current?.getGpuLayer(activeId);
    if (!layer) return;
    // Copied in the layer's own format; the selection scales alpha
    // (feathered edges).
    writeToClipboard(
      cropToClipboard(
        {
          format: layer.format,
          data: layer.data,
          width: layer.layerWidth,
          height: layer.layerHeight,
          offsetX: layer.offsetX,
          offsetY: layer.offsetY,
          palette: state.swatches,
        },
        activeScope().selection.mask,
        state.canvas.width,
        state.canvas.height,
      ),
    );
  }, [state.activeLayerId, state.canvas, state.swatches, canvasHandleRef]);

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
      const clipData = await resolveClipboard(dstW, dstH);
      if (!clipData) return;

      const { width: srcW, height: srcH, offsetX, offsetY } = clipData;
      const newId = makeTabId();
      // Convert to the document's format (nearest palette colour in an
      // indexed8 document).
      const docFormat = state.pixelFormat;
      const pasteData = await clipboardToFormat(
        clipData,
        docFormat,
        state.swatches,
      );
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
  }, [
    state.canvas,
    state.pixelFormat,
    state.swatches,
    dispatch,
    canvasHandleRef,
    pendingLayerLabelRef,
  ]);

  const handleCopyMerged = useCallback((): void => {
    void (async () => {
      const { width, height } = state.canvas;
      const result =
        await canvasHandleRef.current?.rasterizeComposite("sample");
      if (!result) return;
      // The composite is scene-linear floats in rgba32f documents, RGBA
      // bytes otherwise (indexed8 documents composite to colours).
      writeToClipboard(
        cropToClipboard(
          {
            format: result.data instanceof Float32Array ? "rgba32f" : "rgba8",
            data: result.data,
            width: result.width,
            height: result.height,
            offsetX: 0,
            offsetY: 0,
          },
          null,
          width,
          height,
        ),
      );
    })();
  }, [state.canvas, canvasHandleRef]);

  const handlePasteInto = useCallback((): void => {
    const sourceMask = activeScope().selection.mask;
    if (!sourceMask) return; // no-op without an active selection
    const selMask = sourceMask.slice(); // snapshot before async
    void (async () => {
      const { width: dstW, height: dstH } = state.canvas;

      const clipData = await resolveClipboard(dstW, dstH);
      if (!clipData) return;

      const { width: srcW, height: srcH, offsetX, offsetY } = clipData;
      // Position the layer at the selection's top-left corner so that the pasted
      // content's origin aligns with the origin of the selection bounding box.
      const bounds = selectionBounds(selMask, dstW, dstH);
      const pasteX = bounds ? bounds.x : offsetX;
      const pasteY = bounds ? bounds.y : offsetY;
      const newId = makeTabId();
      const maskId = makeTabId();

      // Same conversion as the regular Paste path.
      const docFormat = state.pixelFormat;
      const pasteData = await clipboardToFormat(
        clipData,
        docFormat,
        state.swatches,
      );
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
  }, [
    state.canvas,
    state.pixelFormat,
    state.swatches,
    dispatch,
    canvasHandleRef,
    pendingLayerLabelRef,
  ]);

  return {
    handleCopy,
    handleCopyMerged,
    handleCut,
    handlePaste,
    handlePasteInto,
    handleDelete,
  };
}
