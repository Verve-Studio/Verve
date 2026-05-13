import { useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AppState } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { AppAction } from "@/core/store/AppContext";
import { activeScope } from "@/core/store/scope";
import {
  objectRemovalRunner,
  objectRemovalStatus,
  notifyObjectRemovalStatusChange,
} from "@/core/tools/ObjectRemoval/ObjectRemoval";

interface UseObjectRemovalOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  captureHistory: (label: string) => void;
  dispatch: Dispatch<AppAction>;
  /** Flips while LaMa inference is in flight so MainWindow can render a
   *  blocking progress overlay. */
  setBusy?: Dispatch<SetStateAction<boolean>>;
}

/**
 * Wires the ObjectRemoval tool's module-level `objectRemovalRunner.apply` to
 * a closure with access to dispatch + the canvas handle. On "Apply" the
 * runner reads the painted mask from the per-document `inpaintMask` store
 * plus the active layer's pixels, sends both to the main-process LaMa
 * inference, and writes the composited result back via `writeLayerPixels`.
 *
 * The mask is cleared after a successful apply so the user can start the
 * next removal from a clean slate.
 */
export function useObjectRemoval({
  canvasHandleRef,
  stateRef,
  captureHistory,
  dispatch: _dispatch,
  setBusy,
}: UseObjectRemovalOptions): void {
  const runningRef = useRef(false);

  // Check model availability on mount.
  useEffect(() => {
    let cancelled = false;
    objectRemovalStatus.model = "checking";
    notifyObjectRemovalStatusChange();
    void (async (): Promise<void> => {
      try {
        const res = await window.api.inpaint.checkModel();
        if (cancelled) return;
        objectRemovalStatus.model = res.ready ? "ready" : "missing";
        objectRemovalStatus.searchedPaths = res.searchedPaths;
        notifyObjectRemovalStatusChange();
      } catch {
        if (cancelled) return;
        objectRemovalStatus.model = "error";
        notifyObjectRemovalStatusChange();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    objectRemovalRunner.isRunning = () => runningRef.current;
    objectRemovalRunner.apply = async (): Promise<void> => {
      if (runningRef.current) return;
      const handle = canvasHandleRef.current;
      if (!handle) return;
      const state = stateRef.current;
      const activeId = state.activeLayerId;
      if (!activeId) return;
      if (state.pixelFormat !== "rgba8") {
        console.warn(
          "[ObjectRemoval] Only rgba8 documents supported, got",
          state.pixelFormat,
        );
        return;
      }
      const activeLayer = state.layers.find((l) => l.id === activeId);
      if (!activeLayer) return;
      if (
        "type" in activeLayer &&
        (activeLayer.type === "mask" ||
          activeLayer.type === "adjustment" ||
          activeLayer.type === "text" ||
          activeLayer.type === "shape" ||
          activeLayer.type === "frame" ||
          activeLayer.type === "group")
      ) {
        console.warn(
          "[ObjectRemoval] Active layer is a",
          activeLayer.type,
          "— rasterize first",
        );
        return;
      }
      const layerPixels = handle.getLayerPixels(activeId);
      if (!layerPixels) return;

      const maskStore = activeScope().inpaintMask;
      const mask = maskStore.mask;
      if (!mask || !maskStore.hasMaskedPixels()) {
        return;
      }
      const w = state.canvas.width;
      const h = state.canvas.height;
      if (maskStore.width !== w || maskStore.height !== h) {
        console.warn(
          `[ObjectRemoval] mask dims ${maskStore.width}×${maskStore.height} ≠ canvas ${w}×${h}`,
        );
        return;
      }

      runningRef.current = true;
      setBusy?.(true);
      notifyObjectRemovalStatusChange();
      try {
        const result = await window.api.inpaint.run({
          rgba: layerPixels,
          mask,
          width: w,
          height: h,
        });
        if (result.rgba.length !== w * h * 4) {
          throw new Error(
            `inpaint returned rgba length ${result.rgba.length}; expected ${w * h * 4}`,
          );
        }
        captureHistory("Before Object Removal");
        handle.writeLayerPixels(activeId, result.rgba);
        maskStore.clear();
      } catch (err) {
        console.error("[ObjectRemoval] inference failed:", err);
      } finally {
        runningRef.current = false;
        setBusy?.(false);
        notifyObjectRemovalStatusChange();
      }
    };
    return () => {
      objectRemovalRunner.apply = async () => {};
      objectRemovalRunner.isRunning = () => false;
    };
  }, [canvasHandleRef, stateRef, captureHistory, setBusy]);
}
