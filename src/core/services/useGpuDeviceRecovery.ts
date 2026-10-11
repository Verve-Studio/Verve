import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { TabRecord } from "@/core/store/tabTypes";
import {
  onGpuDeviceLost,
  onGpuUncapturedError,
} from "@/graphics/webgpu/device/GpuDevice";
import { notificationStore } from "@/core/store/notificationStore";
import type { LayerDataBundle } from "@/core/store/layerPayload";

interface UseGpuDeviceRecoveryOptions {
  activeTabIdRef: { readonly current: string };
  serializeActiveTabPixels: () => LayerDataBundle | null;
  setTabs: Dispatch<SetStateAction<TabRecord[]>>;
  setPendingLayerData: Dispatch<SetStateAction<LayerDataBundle | null>>;
}

/**
 * Recover from loss of the shared WebGPU device (driver reset / TDR, GPU
 * process crash, GPU OOM). Without this the canvas silently freezes: every
 * submit on a lost device is a no-op and every readback rejects.
 *
 * Layer pixels live in CPU memory (`layer.data`), so the active document
 * survives: serialize it the same way a tab switch does, then bump the tab's
 * `canvasKey` so the Canvas remounts and builds a renderer on a new device.
 * Background tabs are already serialized and remount on their next switch.
 *
 * Also surfaces GPU errors that no error scope captured.
 */
export function useGpuDeviceRecovery({
  activeTabIdRef,
  serializeActiveTabPixels,
  setTabs,
  setPendingLayerData,
}: UseGpuDeviceRecoveryOptions): void {
  const serializeRef = useRef(serializeActiveTabPixels);
  serializeRef.current = serializeActiveTabPixels;

  useEffect(() => {
    const unsubscribeLost = onGpuDeviceLost((info) => {
      notificationStore.error(
        `The GPU device was lost (${info.message || info.reason}). ` +
          "Verve is restoring the canvas.",
      );
      const tabId = activeTabIdRef.current;
      if (!tabId) return;
      const pixels = serializeRef.current();
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId ? { ...t, canvasKey: t.canvasKey + 1 } : t,
        ),
      );
      setPendingLayerData(pixels);
    });

    // Uncaptured errors can repeat every frame; show at most one per 10 s.
    let lastShown = -Infinity;
    const unsubscribeError = onGpuUncapturedError((error) => {
      const now = performance.now();
      if (now - lastShown < 10_000) return;
      lastShown = now;
      notificationStore.error(`GPU error: ${error.message}`);
    });

    return () => {
      unsubscribeLost();
      unsubscribeError();
    };
  }, [activeTabIdRef, setTabs, setPendingLayerData]);
}
