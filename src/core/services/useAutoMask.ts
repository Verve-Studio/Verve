import { useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AppState } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { AppAction } from "@/core/store/AppContext";
import {
  autoMaskRunner,
  autoMaskStatus,
  notifyAutoMaskStatusChange,
  type AutoMaskRoi,
} from "@/core/tools/AutoMask/AutoMask";

interface UseAutoMaskOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  captureHistory: (label: string) => void;
  dispatch: Dispatch<AppAction>;
  /** Flips while inference is in flight so MainWindow can render a
   *  blocking progress overlay. */
  setBusy?: Dispatch<SetStateAction<boolean>>;
}

/**
 * Wires the Auto-Mask tool's module-level `autoMaskRunner.run` to a closure
 * that has access to the canvas handle + dispatch. On click the tool just
 * calls `autoMaskRunner.run()` — all the actual work lives here so the tool
 * file stays free of renderer-state plumbing.
 *
 * The runner:
 *  1. Reads the active layer's canvas-sized RGBA via `getLayerPixels`.
 *  2. Sends it to the main process for ISNet inference.
 *  3. Writes the returned 0–255 mask into the R channel of a canvas-sized
 *     RGBA buffer (G/B = 0, A = 255 — the convention `MaskLayerState` uses).
 *  4. Either updates the parent layer's existing mask pixel buffer via
 *     `writeLayerPixels` or creates a fresh mask layer via
 *     `prepareNewLayer` + `ADD_MASK_LAYER`.
 *
 * Re-running on a layer that already has a mask refreshes the mask in place
 * — useful for iterating on a detection result without piling up dead masks.
 */
export function useAutoMask({
  canvasHandleRef,
  stateRef,
  captureHistory,
  dispatch,
  setBusy,
}: UseAutoMaskOptions): void {
  const runningRef = useRef(false);

  // Check model availability on mount.
  useEffect(() => {
    let cancelled = false;
    autoMaskStatus.model = "checking";
    notifyAutoMaskStatusChange();
    void (async (): Promise<void> => {
      try {
        const res = await window.api.isnet.checkModel();
        if (cancelled) return;
        autoMaskStatus.model = res.ready ? "ready" : "missing";
        autoMaskStatus.searchedPaths = res.searchedPaths;
        notifyAutoMaskStatusChange();
      } catch {
        if (cancelled) return;
        autoMaskStatus.model = "error";
        notifyAutoMaskStatusChange();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    autoMaskRunner.isRunning = () => runningRef.current;
    autoMaskRunner.run = async (roi?: AutoMaskRoi): Promise<void> => {
      if (runningRef.current) return;
      const handle = canvasHandleRef.current;
      if (!handle) return;
      const state = stateRef.current;
      const activeId = state.activeLayerId;
      if (!activeId) return;
      if (state.pixelFormat !== "rgba8") {
        console.warn(
          "[AutoMask] Only rgba8 documents supported, got",
          state.pixelFormat,
        );
        return;
      }
      const activeLayer = state.layers.find((l) => l.id === activeId);
      if (!activeLayer) return;
      // Mask layers and adjustment layers don't hold the kind of pixel data
      // ISNet needs — bail rather than producing garbage.
      if (
        "type" in activeLayer &&
        (activeLayer.type === "mask" || activeLayer.type === "adjustment")
      ) {
        console.warn(
          "[AutoMask] Active layer is a",
          activeLayer.type,
          "— skip",
        );
        return;
      }
      const layerPixels = handle.getLayerPixels(activeId);
      if (!layerPixels) return;

      const w = state.canvas.width;
      const h = state.canvas.height;

      // Resolve the inference region. If `roi` was supplied we crop the
      // canvas-sized layer pixels down to that rectangle; ISNet then only
      // "sees" the user-chosen area, which is the whole point of providing
      // an ROI. When no roi is given, we just feed the full canvas.
      let inputRgba: Uint8Array;
      let inputW: number;
      let inputH: number;
      let roiX: number;
      let roiY: number;
      if (roi) {
        roiX = Math.max(0, Math.min(w - 1, Math.floor(roi.x)));
        roiY = Math.max(0, Math.min(h - 1, Math.floor(roi.y)));
        inputW = Math.max(1, Math.min(w - roiX, Math.ceil(roi.w)));
        inputH = Math.max(1, Math.min(h - roiY, Math.ceil(roi.h)));
        // ISNet downsamples to 1024² — anything tiny will not produce a
        // meaningful detection.
        if (inputW < 16 || inputH < 16) {
          console.warn("[AutoMask] ROI too small, skipping");
          return;
        }
        inputRgba = new Uint8Array(inputW * inputH * 4);
        for (let y = 0; y < inputH; y++) {
          const srcOffset = ((roiY + y) * w + roiX) * 4;
          const dstOffset = y * inputW * 4;
          inputRgba.set(
            layerPixels.subarray(srcOffset, srcOffset + inputW * 4),
            dstOffset,
          );
        }
      } else {
        inputRgba = layerPixels;
        inputW = w;
        inputH = h;
        roiX = 0;
        roiY = 0;
      }

      runningRef.current = true;
      setBusy?.(true);
      notifyAutoMaskStatusChange();
      try {
        const result = await window.api.isnet.run({
          rgba: inputRgba,
          width: inputW,
          height: inputH,
        });
        if (result.mask.length !== inputW * inputH) {
          throw new Error(
            `isnet returned mask length ${result.mask.length}; expected ${inputW * inputH}`,
          );
        }
        // Build a canvas-sized RGBA mask buffer: A = 255 everywhere, R = mask
        // intensity inside the ROI (and 0 outside, so the unmasked area
        // stays fully hidden by the mask layer). Mask layers use the R
        // channel to drive blend weight.
        const maskRgba = new Uint8Array(w * h * 4);
        for (let i = 3; i < maskRgba.length; i += 4) maskRgba[i] = 255;
        const m = result.mask;
        for (let y = 0; y < inputH; y++) {
          for (let x = 0; x < inputW; x++) {
            maskRgba[((roiY + y) * w + (roiX + x)) * 4] = m[y * inputW + x];
          }
        }

        const existingMask = state.layers.find(
          (l) =>
            "type" in l &&
            l.type === "mask" &&
            (l as { parentId: string }).parentId === activeId,
        );

        captureHistory(
          existingMask ? "Before Auto-Mask Update" : "Before Auto-Mask",
        );

        if (existingMask) {
          handle.writeLayerPixels(existingMask.id, maskRgba);
        } else {
          const maskId = `mask-${Date.now()}`;
          handle.prepareNewLayer(maskId, "Auto Mask", maskRgba);
          dispatch({
            type: "ADD_MASK_LAYER",
            payload: {
              id: maskId,
              name: "Auto Mask",
              visible: true,
              type: "mask",
              parentId: activeId,
            },
          });
        }
      } catch (err) {
        console.error("[AutoMask] inference failed:", err);
      } finally {
        runningRef.current = false;
        setBusy?.(false);
        notifyAutoMaskStatusChange();
      }
    };
    return () => {
      autoMaskRunner.run = async () => {};
      autoMaskRunner.isRunning = () => false;
    };
  }, [canvasHandleRef, stateRef, captureHistory, dispatch, setBusy]);
}
