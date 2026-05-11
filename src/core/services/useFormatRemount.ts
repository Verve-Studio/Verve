import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AppState, PixelFormat } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { TabRecord } from "@/core/store/tabTypes";
import {
  f32TransferStore,
  u8TransferStore,
} from "@/core/store/layerDataTransfer";

interface UseFormatRemountOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  activeTabId: string;
  setTabs: Dispatch<SetStateAction<TabRecord[]>>;
  setPendingLayerData: Dispatch<SetStateAction<Map<string, string> | null>>;
  captureHistory: (label: string) => void;
}

/** Captures all layer pixel data + geometry, hands them to the transfer
 *  stores, and bumps `canvasKey` to force a Canvas remount in the new
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
    (toFormat: PixelFormat): void => {
      const handle = canvasHandleRef.current;
      if (!handle) return;
      const layerGeo = handle.captureAllLayerGeometry();
      const encoded = new Map<string, string>();
      for (const ls of stateRef.current.layers) {
        if ("type" in ls) continue;
        const raw = handle.getLayerRawData(ls.id);
        if (!raw) continue;
        const geo = layerGeo.get(ls.id);
        if (geo) encoded.set(`${ls.id}:geo`, JSON.stringify(geo));
        const CHUNK = 65535;
        if (toFormat === "rgba32f") {
          // Store the typed array directly — avoids ~576 MB of base64/atob
          // intermediaries for large images.
          f32TransferStore.set(ls.id, raw as Float32Array);
          encoded.set(ls.id, `data:raw/f32-ref;id=${ls.id}`);
        } else if (toFormat === "indexed8") {
          const u8 = raw as Uint8Array;
          let b64 = "";
          for (let i = 0; i < u8.length; i += CHUNK) {
            b64 += btoa(
              String.fromCharCode(...Array.from(u8.subarray(i, i + CHUNK))),
            );
          }
          encoded.set(ls.id, `data:raw/indexed8;base64,${b64}`);
        } else {
          u8TransferStore.set(ls.id, raw as Uint8Array);
          encoded.set(ls.id, `data:raw/rgba8-ref;id=${ls.id}`);
        }
      }
      setPendingLayerData(encoded);
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
