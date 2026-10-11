import { useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AppState } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { AppAction } from "@/core/store/AppContext";
import { activeScope } from "@/core/store/scope";
import {
  objectRemovalOptions,
  objectRemovalRunner,
  objectRemovalStatus,
  notifyObjectRemovalStatusChange,
} from "@/core/tools/ObjectRemoval/ObjectRemoval";
import { newLayerId } from "@/utils/layerId";
import { showOperationError } from "@/utils/userFeedback";

interface UseObjectRemovalOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  captureHistory: (label: string) => void;
  dispatch: Dispatch<AppAction>;
  /** Sets the React-side label used by the next `captureHistory` call after
   *  a new-layer insertion, so the entry shows "Object Removal" instead of
   *  the generic auto-capture label. Mirrors the pattern used by the
   *  duplicate / new-layer paths. */
  pendingLayerLabelRef: MutableRefObject<string | null>;
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
  dispatch,
  pendingLayerLabelRef,
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
        showOperationError(
          "Object Removal failed.",
          "Object Removal only supports 8-bit RGBA documents.",
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
        showOperationError(
          "Object Removal failed.",
          `The active layer is a ${activeLayer.type} layer. Rasterize it first.`,
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
      // The document the run started on: a tab switch during inference must
      // not write the result into another document.
      const scope = activeScope();
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
        if (activeScope() !== scope || canvasHandleRef.current !== handle) {
          throw new Error(
            "The document changed while Object Removal was running.",
          );
        }
        if (!stateRef.current.layers.some((l) => l.id === activeId)) {
          throw new Error("The layer was removed while Object Removal was running.");
        }
        if (objectRemovalOptions.outputToNewLayer) {
          // Build a transparent-outside-mask patch so the new layer holds
          // ONLY the inpainted region. The user can then erase / blend /
          // toggle visibility to revert without touching the original.
          const patch = new Uint8Array(w * h * 4);
          for (let i = 0; i < w * h; i++) {
            if (mask[i] > 0) {
              const o = i * 4;
              patch[o] = result.rgba[o];
              patch[o + 1] = result.rgba[o + 1];
              patch[o + 2] = result.rgba[o + 2];
              patch[o + 3] = result.rgba[o + 3];
            }
          }
          const newId = newLayerId("layer");
          const newName = `${activeLayer.name} retouch`;
          handle.prepareNewLayer(newId, newName, patch);
          pendingLayerLabelRef.current = "Object Removal";
          dispatch({
            type: "INSERT_LAYER_ABOVE",
            payload: {
              aboveId: activeId,
              layer: {
                id: newId,
                name: newName,
                visible: true,
                opacity: 1,
                locked: false,
                blendMode: "normal",
              },
            },
          });
        } else {
          handle.writeLayerPixels(activeId, result.rgba);
          captureHistory("Object Removal");
        }
        maskStore.clear();
      } catch (err) {
        console.error("[ObjectRemoval] inference failed:", err);
        showOperationError("Object Removal failed.", err);
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
  }, [canvasHandleRef, stateRef, captureHistory, dispatch, pendingLayerLabelRef, setBusy]);
}
