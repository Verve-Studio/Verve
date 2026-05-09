import type { AppAction } from "@/core/store/AppContext";

import type { AppState } from "@/types";
import { computeSourceMask } from "@/utils/computeSourceMask";
import { extractErrorMessage } from "@/utils/userFeedback";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { getPixelOps, inpaintRegion } from "@/wasm";
import type { Dispatch, MutableRefObject } from "react";
import { useCallback, useRef } from "react";
import { activeScope } from "@/core/store/scope";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseContentAwareFillOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  captureHistory: (label: string) => void;
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

export function useContentAwareFill({
  canvasHandleRef,
  stateRef,
  captureHistory,
  dispatch,
  pendingLayerLabelRef,
  setIsContentAwareFilling,
  setFillLabel,
  onError,
}: UseContentAwareFillOptions): UseContentAwareFillReturn {
  const isRunningRef = useRef(false);

  const runInpaint = useCallback(
    async (
      eraseActiveLayer: boolean,
      samplingRadius: number,
    ): Promise<void> => {
      if (isRunningRef.current) return;
      isRunningRef.current = true;
      const handle = canvasHandleRef.current;

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
          isRunningRef.current = false;
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

        // Run PatchMatch inpainting — mask is canvas-space 1ch (255=fill, 0=source)
        const inpainted = await inpaintRegion(
          composite as Uint8Array,
          width,
          height,
          mask,
          sourceMask ?? undefined,
        );

        // Build fill layer: inpainted pixels only where mask is set; transparent elsewhere
        const fillLayerData = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          if (mask[i]) {
            fillLayerData[i * 4] = inpainted[i * 4];
            fillLayerData[i * 4 + 1] = inpainted[i * 4 + 1];
            fillLayerData[i * 4 + 2] = inpainted[i * 4 + 2];
            fillLayerData[i * 4 + 3] = inpainted[i * 4 + 3];
          }
        }

        // Capture pre-operation history snapshot
        captureHistory(label);
        // Also set pendingLayerLabelRef so the auto-capture (on layer count increase)
        // uses the correct label instead of 'New Layer'
        pendingLayerLabelRef.current = label;

        // Prepare GPU layer (before dispatching so the sync effect is a no-op)
        const newLayerId = `layer-${Date.now()}`;
        handle.prepareNewLayer(newLayerId, label, fillLayerData);

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

        dispatch({ type: "REORDER_LAYERS", payload: updatedLayers });
        dispatch({ type: "SET_ACTIVE_LAYER", payload: newLayerId });
      } catch (error) {
        onError(
          `${eraseActiveLayer ? "Content-Aware Delete" : "Content-Aware Fill"} failed: ${extractErrorMessage(error)}`,
        );
      } finally {
        setIsContentAwareFilling(false);
        isRunningRef.current = false;
      }
    },
    [
      canvasHandleRef,
      stateRef,
      captureHistory,
      dispatch,
      pendingLayerLabelRef,
      setIsContentAwareFilling,
      setFillLabel,
      onError,
    ],
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
