import type { AppAction } from "@/core/store/AppContext";

import type { AppState } from "@/types";
import { computeSourceMask } from "@/utils/computeSourceMask";
import { clampF32ToUint8 } from "@/utils/pixelFormatConvert";
import { extractErrorMessage } from "@/utils/userFeedback";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { getPixelOps } from "@/wasm";
import type { Dispatch, MutableRefObject } from "react";
import { useCallback, useRef } from "react";
import { activeScope } from "@/core/store/scope";
import { convertPixelBuffer } from "@/utils/convertPixelBuffer";
import { inpaintRegionOffThread } from "@/wasm/pixelopsWorkerClient";
import { newLayerId as makeLayerId } from "@/utils/layerId";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseContentAwareFillOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  /** Unused: the result is recorded through `pendingLayerLabelRef`. */
  captureHistory?: (label: string) => void;
  dispatch: Dispatch<AppAction>;
  pendingLayerLabelRef: MutableRefObject<string | null>;
  setIsContentAwareFilling: (v: boolean) => void;
  setFillLabel: (v: string) => void;
  onError: (msg: string) => void;
}

export interface UseContentAwareFillReturn {
  runContentAwareFill: (samplingRadius: number) => Promise<void>;
  runContentAwareDelete: (samplingRadius: number) => Promise<void>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * The Content-Aware Fill layer: the inpainted sRGB RGBA8 pixels inside the
 * selection, transparent elsewhere. A soft (feathered) selection scales the
 * fill's alpha by mask / 255 so it blends into the surroundings.
 */
export function buildFillLayerPixels(
  inpainted: Uint8Array,
  mask: Uint8Array,
  pixelCount: number,
): Uint8Array {
  const out = new Uint8Array(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    const m = mask[i];
    if (!m) continue;
    const p = i * 4;
    out[p] = inpainted[p];
    out[p + 1] = inpainted[p + 1];
    out[p + 2] = inpainted[p + 2];
    out[p + 3] = m === 255 ? inpainted[p + 3] : Math.round((inpainted[p + 3] * m) / 255);
  }
  return out;
}

export function useContentAwareFill({
  canvasHandleRef,
  stateRef,
  dispatch,
  pendingLayerLabelRef,
  setIsContentAwareFilling,
  setFillLabel,
  onError,
}: UseContentAwareFillOptions): UseContentAwareFillReturn {
  const isRunningRef = useRef(false);

  const runInpaintOnce = useCallback(
    async (
      eraseActiveLayer: boolean,
      samplingRadius: number,
    ): Promise<void> => {
      const handle = canvasHandleRef.current;
      // The document the operation started on: a tab switch during the
      // awaits below must not drop the result into another document.
      const scope = activeScope();

      // Guard: selection must exist
      if (!activeScope().selection.hasSelection()) return;
      const mask = activeScope().selection.mask!;

      // Guard: selection bounding box must be at least 4×4
      const { canvas, activeLayerId } = stateRef.current;
      const { width: cw, height: ch } = canvas;
      let minX = cw,
        minY = ch,
        maxX = 0,
        maxY = 0;
      for (let i = 0; i < cw * ch; i++) {
        if (mask[i]) {
          const x = i % cw;
          const y = Math.floor(i / cw);
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
      if (maxX - minX < 3 || maxY - minY < 3) {
        onError(
          "Content-Aware Fill requires a selection of at least 4×4 pixels.",
        );
        return;
      }

      // Guard: WASM must be ready
      try {
        await getPixelOps();
      } catch {
        onError("WASM module is not ready. Please wait and try again.");
        return;
      }

      // Compute source mask from sampling radius
      const sourceMask = computeSourceMask(mask, cw, ch, samplingRadius);

      if (sourceMask !== null) {
        const PATCH_SIZE = 4;
        const MIN_SOURCE_PIXELS = (2 * PATCH_SIZE + 1) ** 2;
        let eligibleCount = 0;
        for (let i = 0; i < sourceMask.length; i++)
          eligibleCount += sourceMask[i];
        if (eligibleCount < MIN_SOURCE_PIXELS) {
          onError(
            "Sampling radius is too small — no source pixels available. " +
              "Try a larger radius or set it to 0.",
          );
          return;
        }
      }

      if (!handle) return;

      const label = eraseActiveLayer
        ? "Content-Aware Delete"
        : "Content-Aware Fill";

      try {
        setFillLabel(eraseActiveLayer ? "Deleting…" : "Filling…");
        setIsContentAwareFilling(true);

        // Flatten all visible layers to a canvas-sized RGBA composite
        const {
          data: composite,
          width,
          height,
        } = await handle.rasterizeComposite("sample");

        // Run PatchMatch inpainting — mask is canvas-space 1ch (255=fill, 0=source).
        // Inpainting works on sRGB bytes; an rgba32f composite is converted
        // with the transfer function (the fill is decoded back below).
        const compositeBytes =
          composite instanceof Float32Array
            ? clampF32ToUint8(composite)
            : (composite as Uint8Array);
        const inpainted = await inpaintRegionOffThread(
          compositeBytes,
          width,
          height,
          mask,
          sourceMask ?? undefined,
        );

        const fillLayerData = buildFillLayerPixels(inpainted, mask, width * height);

        if (activeScope() !== scope || canvasHandleRef.current !== handle) {
          throw new Error("the document changed while it was running");
        }

        // Prepare GPU layer (before dispatching so the sync effect is a no-op).
        // The inpainting algorithm always returns sRGB RGBA8 bytes; they're
        // converted to the doc format (gamma-decoded floats in an f32 doc,
        // nearest palette indices in an indexed8 doc).
        const newLayerId = makeLayerId("layer");
        const docFormat = stateRef.current.pixelFormat;
        const layerData = await convertPixelBuffer(
          fillLayerData,
          "rgba8",
          docFormat,
          stateRef.current.swatches,
        );
        handle.prepareNewLayer(
          newLayerId,
          label,
          layerData,
          undefined,
          undefined,
          undefined,
          undefined,
          docFormat,
        );
        if (activeScope() !== scope || canvasHandleRef.current !== handle) {
          throw new Error("the document changed while it was running");
        }

        // Content-Aware Delete: erase BEFORE REORDER_LAYERS dispatch so that the
        // auto-history-capture triggered by layer count change records the fully
        // complete post-operation state (erased pixels + fill layer).
        if (eraseActiveLayer && activeLayerId) {
          handle.clearLayerPixels(activeLayerId, mask);
        }

        // Insert new layer directly above the active layer
        const currentLayers = stateRef.current.layers;
        const activeIdx = activeLayerId
          ? currentLayers.findIndex((l) => l.id === activeLayerId)
          : currentLayers.length - 1;
        const insertIdx = activeIdx >= 0 ? activeIdx + 1 : currentLayers.length;

        const newLayerMeta = {
          id: newLayerId,
          name: label,
          visible: true,
          opacity: 1,
          locked: false,
          blendMode: "normal" as const,
        };
        const updatedLayers = [
          ...currentLayers.slice(0, insertIdx),
          newLayerMeta,
          ...currentLayers.slice(insertIdx),
        ];

        // One entry for the whole result (fill layer + erased pixels),
        // recorded by useHistory once the new layer is committed.
        pendingLayerLabelRef.current = label;
        dispatch({ type: "REORDER_LAYERS", payload: updatedLayers });
        dispatch({ type: "SET_ACTIVE_LAYER", payload: newLayerId });
      } catch (error) {
        onError(
          `${eraseActiveLayer ? "Content-Aware Delete" : "Content-Aware Fill"} failed: ${extractErrorMessage(error)}`,
        );
      } finally {
        setIsContentAwareFilling(false);
      }
    },
    [
      canvasHandleRef,
      stateRef,
      dispatch,
      pendingLayerLabelRef,
      setIsContentAwareFilling,
      setFillLabel,
      onError,
    ],
  );

  const runInpaint = useCallback(
    async (
      eraseActiveLayer: boolean,
      samplingRadius: number,
    ): Promise<void> => {
      if (isRunningRef.current) return;
      isRunningRef.current = true;
      try {
        await runInpaintOnce(eraseActiveLayer, samplingRadius);
      } finally {
        // Every exit (guards included) must release the lock, or one
        // "selection too small" error disables the command for good.
        isRunningRef.current = false;
      }
    },
    [runInpaintOnce],
  );

  const runContentAwareFill = useCallback(
    (samplingRadius: number) => runInpaint(false, samplingRadius),
    [runInpaint],
  );
  const runContentAwareDelete = useCallback(
    (samplingRadius: number) => runInpaint(true, samplingRadius),
    [runInpaint],
  );

  return { runContentAwareFill, runContentAwareDelete };
}
