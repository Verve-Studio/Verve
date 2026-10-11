import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AppState, PixelFormat } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { TabRecord } from "@/core/store/tabTypes";
import {
  createLayerDataBundle,
  type LayerDataBundle,
} from "@/core/store/layerPayload";

interface UseFormatRemountOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  activeTabId: string;
  setTabs: Dispatch<SetStateAction<TabRecord[]>>;
  setPendingLayerData: Dispatch<SetStateAction<LayerDataBundle | null>>;
  captureHistory: (label: string) => void;
}

/** Copies every pixel layer's (already converted) data + geometry into a
 *  pending bundle and bumps `canvasKey` to force a Canvas remount in the new
 *  pixel format. Used when switching color modes between rgba8 / rgba32f /
 *  indexed8. */
export function useFormatRemount({
  canvasHandleRef,
  stateRef,
  activeTabId,
  setTabs,
  setPendingLayerData,
  captureHistory,
}: UseFormatRemountOptions): (toFormat: PixelFormat) => void {
  return useCallback(
    (_toFormat: PixelFormat): void => {
      const handle = canvasHandleRef.current;
      if (!handle) return;
      const pending = createLayerDataBundle();
      for (const ls of stateRef.current.layers) {
        if ("type" in ls) continue;
        const gpu = handle.getGpuLayer(ls.id);
        if (!gpu) continue;
        pending.layers.set(ls.id, {
          format: gpu.format,
          data: gpu.data.slice(),
          geo: {
            layerWidth: gpu.layerWidth,
            layerHeight: gpu.layerHeight,
            offsetX: gpu.offsetX,
            offsetY: gpu.offsetY,
          },
        });
      }
      setPendingLayerData(pending);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId ? { ...t, canvasKey: t.canvasKey + 1 } : t,
        ),
      );
      captureHistory("Convert Color Mode");
    },
    [
      canvasHandleRef,
      stateRef,
      activeTabId,
      setTabs,
      setPendingLayerData,
      captureHistory,
    ],
  );
}
