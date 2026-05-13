import { useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AppState } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { AppAction } from "@/core/store/AppContext";
import {
  autoMaskRunner,
  autoMaskStatus,
  notifyAutoMaskStatusChange,
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
    autoMaskRunner.run = async (): Promise<void> => {
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

      runningRef.current = true;
      setBusy?.(true);
      notifyAutoMaskStatusChange();
      try {
        const w = state.canvas.width;
        const h = state.canvas.height;
        const result = await window.api.isnet.run({
          rgba: layerPixels,
          width: w,
          height: h,
        });
        if (result.mask.length !== w * h) {
          throw new Error(
            `isnet returned mask length ${result.mask.length}; expected ${w * h}`,
          );
        }
        // Build canvas-sized RGBA mask: R = mask intensity, G/B = 0, A = 255.
        // This is the layout the renderer expects for mask layers (R drives
        // the alpha blend weight).
        const maskRgba = new Uint8Array(w * h * 4);
        const m = result.mask;
        for (let i = 0; i < m.length; i++) {
          const o = i * 4;
          maskRgba[o] = m[i];
          maskRgba[o + 3] = 255;
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
