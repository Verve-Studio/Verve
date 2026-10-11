import { materializeSnapshot } from "@/core/store/tiledSnapshot";
import type { AppAction } from "@/core/store/AppContext";
import type { ClearHistoryOptions } from "@/core/store/historyStore";

import {
  createLayerDataBundle,
  type LayerDataBundle,
} from "@/core/store/layerPayload";
import { preferencesStore } from "@/core/store/preferencesStore";
import type { TabRecord } from "@/core/store/tabTypes";
import type { AppState, RGBAColor } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { Dispatch, MutableRefObject } from "react";
import { useCallback, useEffect, useRef } from "react";
import { activeScope } from "@/core/store/scope";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseHistoryOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  dispatch: Dispatch<AppAction>;
  activeTabIdRef: MutableRefObject<string>;
  setTabsRef: MutableRefObject<Dispatch<React.SetStateAction<TabRecord[]>>>;
  setPendingLayerData: Dispatch<
    React.SetStateAction<LayerDataBundle | null>
  >;
  /** state.layers — dependency for the auto-capture-on-layer-change effect. */
  layers: AppState["layers"];
}

export interface UseHistoryReturn {
  captureHistory: (
    label: string,
    overrides?: { swatches?: RGBAColor[] },
  ) => void;
  isRestoringRef: MutableRefObject<boolean>;
  suppressReadyCaptureRef: MutableRefObject<boolean>;
  pendingLayerLabelRef: MutableRefObject<string | null>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useHistory({
  canvasHandleRef,
  stateRef,
  dispatch,
  activeTabIdRef,
  setTabsRef,
  setPendingLayerData,
  layers,
}: UseHistoryOptions): UseHistoryReturn {
  const isRestoringRef = useRef(false);
  const suppressReadyCaptureRef = useRef(false);
  const pendingLayerLabelRef = useRef<string | null>(null);
  const prevLayersRef = useRef(layers);

  const captureHistory = useCallback(
    (label: string, overrides?: { swatches?: RGBAColor[] }): void => {
      if (suppressReadyCaptureRef.current) {
        suppressReadyCaptureRef.current = false;
        return;
      }
      const handle = canvasHandleRef.current;
      if (!handle) return;
      if (handle.borrowAllLayerPixels().size === 0) return;
      // Each layer's snapshot shares every tile that is unchanged since the
      // layer's history base (the snapshot last captured or restored for it)
      // and copies only the tiles written since — see tiledSnapshot.ts. The
      // current entry is only a content de-dup fallback for layers without a
      // base (new, grown, remounted, converted).
      const prev = activeScope().history.entries[activeScope().history.currentIndex];
      const layerGeometry = handle.captureAllLayerGeometry();
      const adjustmentMasks = handle.captureAllAdjustmentMasks(
        prev?.adjustmentMasks,
      );
      const layerPixels = handle.captureAllLayerSnapshots(prev?.layerPixels);

      const s = stateRef.current;
      activeScope().history.push({
        id: `hist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        label,
        timestamp: Date.now(),
        layerPixels,
        layerGeometry,
        adjustmentMasks,
        layerState: s.layers,
        activeLayerId: s.activeLayerId,
        canvasWidth: s.canvas.width,
        canvasHeight: s.canvas.height,
        swatches: overrides?.swatches ?? s.swatches,
        iccProfile: s.iccProfile,
        pixelFormat: s.pixelFormat,
      });
    },
    [canvasHandleRef, stateRef],
  );

  // Preview: temporarily show a history entry without moving currentIndex.
  // Restores the same things the jump-to path does (pixels + adjustment masks
  // + layer state) — otherwise the render plan keeps using live state.layers
  // and the preview only partially reflects the snapshot (visibility, blend
  // mode, layer add/delete, adjustment params all stay on current values).
  useEffect(() => {
    activeScope().history.onPreview = (index: number): void => {
      const entry = activeScope().history.entries[index];
      if (!entry) return;
      if (
        entry.canvasWidth !== stateRef.current.canvas.width ||
        entry.canvasHeight !== stateRef.current.canvas.height
      )
        return;
      isRestoringRef.current = true;
      canvasHandleRef.current?.restoreAllLayerPixels(
        entry.layerPixels,
        entry.layerGeometry,
        entry.layerState,
      );
      canvasHandleRef.current?.restoreAllAdjustmentMasks(entry.adjustmentMasks);
      dispatch({
        type: "RESTORE_LAYERS",
        payload: {
          layers: entry.layerState,
          activeLayerId: entry.activeLayerId,
        },
      });
      if (entry.swatches) {
        dispatch({ type: "SET_SWATCHES", payload: entry.swatches });
      }
      dispatch({ type: "SET_ICC_PROFILE", payload: entry.iccProfile });
      if (entry.pixelFormat) {
        dispatch({ type: "SET_PIXEL_FORMAT", payload: entry.pixelFormat });
      }
      setTimeout(() => {
        isRestoringRef.current = false;
      }, 200);
    };
    return () => {
      activeScope().history.onPreview = null;
    };
  }, [canvasHandleRef, stateRef, dispatch]);

  // Jump-to: full restore — may trigger canvas remount for dimension changes
  useEffect(() => {
    activeScope().history.onJumpTo = (index: number): void => {
      const entry = activeScope().history.entries[index];
      if (!entry) return;
      isRestoringRef.current = true;
      const currentW = stateRef.current.canvas.width;
      const currentH = stateRef.current.canvas.height;

      const formatChanged =
        entry.pixelFormat !== undefined &&
        entry.pixelFormat !== stateRef.current.pixelFormat;
      if (
        entry.canvasWidth !== currentW ||
        entry.canvasHeight !== currentH ||
        formatChanged
      ) {
        // Hand the history buffers straight to the remounting canvas (the
        // init path copies them out, so sharing the history's buffers is
        // safe). Each entry records its own format: a jump across a colour-
        // mode conversion restores the pre-conversion format.
        const pending = createLayerDataBundle();
        for (const [id, snap] of entry.layerPixels) {
          pending.layers.set(id, {
            format: snap.float
              ? "rgba32f"
              : snap.channels === 1
                ? "indexed8"
                : "rgba8",
            data: materializeSnapshot(snap),
            geo: entry.layerGeometry?.get(id),
          });
        }
        for (const [layerId, maskSnap] of entry.adjustmentMasks) {
          pending.adjustmentMasks.set(
            layerId,
            materializeSnapshot(maskSnap) as Uint8Array,
          );
        }
        suppressReadyCaptureRef.current = true;
        setPendingLayerData(pending);
        const jumpTabId = activeTabIdRef.current;
        setTabsRef.current((prev) =>
          prev.map((t) =>
            t.id === jumpTabId
              ? {
                  ...t,
                  canvasKey: t.canvasKey + 1,
                  snapshot: {
                    ...t.snapshot,
                    canvasWidth: entry.canvasWidth,
                    canvasHeight: entry.canvasHeight,
                  },
                }
              : t,
          ),
        );
        dispatch({
          type: "SWITCH_TAB",
          payload: {
            width: entry.canvasWidth,
            height: entry.canvasHeight,
            backgroundFill: stateRef.current.canvas.backgroundFill,
            layers: entry.layerState,
            activeLayerId: entry.activeLayerId,
            zoom: stateRef.current.canvas.zoom,
            tiledMode: stateRef.current.canvas.tiledMode,
            showTileGrid: stateRef.current.canvas.showTileGrid,
            // Preserve current format when the entry predates pixel-format
            // capture; the SWITCH_TAB reducer would otherwise reset to rgba8.
            pixelFormat: entry.pixelFormat ?? stateRef.current.pixelFormat,
            iccProfile: entry.iccProfile,
          },
        });
        if (entry.swatches) {
          dispatch({ type: "SET_SWATCHES", payload: entry.swatches });
        }
      } else {
        canvasHandleRef.current?.restoreAllLayerPixels(
          entry.layerPixels,
          entry.layerGeometry,
          entry.layerState,
        );
        canvasHandleRef.current?.restoreAllAdjustmentMasks(
          entry.adjustmentMasks,
        );
        dispatch({
          type: "RESTORE_LAYERS",
          payload: {
            layers: entry.layerState,
            activeLayerId: entry.activeLayerId,
          },
        });
        if (entry.swatches) {
          dispatch({ type: "SET_SWATCHES", payload: entry.swatches });
        }
        dispatch({ type: "SET_ICC_PROFILE", payload: entry.iccProfile });
        if (entry.pixelFormat) {
          dispatch({ type: "SET_PIXEL_FORMAT", payload: entry.pixelFormat });
        }
      }

      activeScope().history.setCurrent(index);
      setTimeout(() => {
        isRestoringRef.current = false;
      }, 200);
    };
    return () => {
      activeScope().history.onJumpTo = null;
    };
  }, [
    dispatch,
    canvasHandleRef,
    stateRef,
    activeTabIdRef,
    setTabsRef,
    setPendingLayerData,
  ]);

  // Register onClear: capture current state as 'History Cleared' entry
  useEffect(() => {
    activeScope().history.onClear = (options?: ClearHistoryOptions): void => {
      if (options?.recaptureSnapshot === false) return;
      captureHistory("History Cleared");
    };
    return () => {
      activeScope().history.onClear = null;
    };
  }, [captureHistory]);

  // Sync history memory cap from preferences. Pushes the current value on
  // mount and re-pushes whenever the user changes it in Preferences →
  // Memory; the store immediately evicts oldest entries to fit.
  useEffect(() => {
    activeScope().history.setMemoryCapBytes(preferencesStore.get().historyMemoryBytes);
    return preferencesStore.subscribe(() => {
      activeScope().history.setMemoryCapBytes(preferencesStore.get().historyMemoryBytes);
    });
  }, []);

  // Auto-capture when layers are added or removed
  useEffect(() => {
    if (isRestoringRef.current) {
      prevLayersRef.current = layers;
      isRestoringRef.current = false;
      return;
    }
    const prev = prevLayersRef.current;
    const curr = layers;
    if (prev !== curr) {
      if (curr.length > prev.length) {
        captureHistory(pendingLayerLabelRef.current ?? "New Layer");
        pendingLayerLabelRef.current = null;
      } else if (curr.length < prev.length) {
        captureHistory("Delete Layer");
      }
      prevLayersRef.current = curr;
    }
  }, [layers, captureHistory]);

  return {
    captureHistory,
    isRestoringRef,
    suppressReadyCaptureRef,
    pendingLayerLabelRef,
  };
}
