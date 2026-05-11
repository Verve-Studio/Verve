import type { AppAction } from "@/core/store/AppContext";

import type { TabRecord, TabSnapshot } from "@/core/store/tabTypes";
import { DEFAULT_SWATCHES } from "@/core/store/tabTypes";
import {
  f32TransferStore,
  u8TransferStore,
} from "@/core/store/layerDataTransfer";
import { displayStore } from "@/ux/main/Canvas/displayStore";
import type { AppState } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setActiveScope } from "@/core/store/scope";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UseTabsReturn {
  tabs: TabRecord[];
  setTabs: Dispatch<SetStateAction<TabRecord[]>>;
  activeTabId: string;
  setActiveTabId: Dispatch<SetStateAction<string>>;
  activeTabIdRef: React.MutableRefObject<string>;
  setTabsRef: React.MutableRefObject<Dispatch<SetStateAction<TabRecord[]>>>;
  canvasHandleRef: { readonly current: CanvasHandle | null };
  pendingLayerData: Map<string, string> | null;
  setPendingLayerData: Dispatch<SetStateAction<Map<string, string> | null>>;
  tabCanvasRef: (tabId: string) => (h: CanvasHandle | null) => void;
  captureActiveSnapshot: () => TabSnapshot;
  serializeActiveTabPixels: () => Map<string, string> | null;
  switchToTab: (toId: string, tabs_: TabRecord[]) => void;
  handleSwitchTab: (toId: string) => void;
  handleCloseTab: (tabId: string) => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useTabs(
  state: AppState,
  dispatch: Dispatch<AppAction>,
): UseTabsReturn {
  // Per-tab canvas handle map — avoids ref-null races on tab close/switch
  const canvasHandlesRef = useRef(new Map<string, CanvasHandle>());
  const canvasRefCallbacksRef = useRef(
    new Map<string, (h: CanvasHandle | null) => void>(),
  );
  const activeTabIdRef = useRef("");
  const setTabsRef = useRef<Dispatch<SetStateAction<TabRecord[]>>>(() => {});

  // Stable proxy — always returns the ACTIVE tab's canvas handle
  const canvasHandleRef = useMemo(
    () => ({
      get current(): CanvasHandle | null {
        return canvasHandlesRef.current.get(activeTabIdRef.current) ?? null;
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }),
    [],
  );

  const [tabs, setTabs] = useState<TabRecord[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const [pendingLayerData, setPendingLayerData] = useState<Map<
    string,
    string
  > | null>(null);

  // Keep refs in sync each render so async closures always see fresh values
  activeTabIdRef.current = activeTabId;
  setTabsRef.current = setTabs;

  // Mirror the active tab's session-only display settings (exposure,
  // tone-map, view-transform LUT) into the module-level displayStore
  // whenever the active tab changes. Covers every entry point — explicit
  // tab switches, file opens, file closes, paste-as-new — without each
  // path needing to remember to reset displayStore manually. Stale state
  // from the previously-active tab would otherwise leak into the next
  // doc's display path (e.g. a Filmic view transform set on Doc A would
  // still show on Doc B until the user touched the Display panel).
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(() => {
    if (!activeTabId) return;
    const tab = tabsRef.current.find((t) => t.id === activeTabId);
    if (!tab) return;
    displayStore.setEV(tab.exposureEV ?? 0);
    displayStore.setOperator(tab.toneMappingOperator ?? "reinhard");
    displayStore.setViewTransformLut(tab.viewTransformLutId ?? null);
  }, [activeTabId]);

  /** Returns a stable callback ref for a given tab id. */
  const tabCanvasRef = useCallback(
    (tabId: string): ((h: CanvasHandle | null) => void) => {
      if (!canvasRefCallbacksRef.current.has(tabId)) {
        canvasRefCallbacksRef.current.set(tabId, (h) => {
          if (h) canvasHandlesRef.current.set(tabId, h);
          else canvasHandlesRef.current.delete(tabId);
        });
      }
      return canvasRefCallbacksRef.current.get(tabId)!;
    },
    [],
  );

  const captureActiveSnapshot = useCallback(
    (): TabSnapshot => ({
      canvasWidth: state.canvas.width,
      canvasHeight: state.canvas.height,
      backgroundFill: state.canvas.backgroundFill,
      layers: state.layers,
      activeLayerId: state.activeLayerId,
      zoom: state.canvas.zoom,
      swatches: state.swatches,
      swatchGroups: state.swatchGroups,
      pixelBrushes: state.pixelBrushes,
      brushes: state.brushes,
      activeBrushId: state.activeBrushId,
      pixelFormat: state.pixelFormat,
      spritesheet: state.spritesheet,
      paletteAnimation: state.paletteAnimation,
    }),
    [state],
  );

  /** Encode every active layer's pixel data into Map<layerId, dataURL> (+ geometry entries).
   *  Must be called while the active tab's Canvas is still mounted. Returns null if no data. */
  const serializeActiveTabPixels = useCallback((): Map<
    string,
    string
  > | null => {
    const layerPixels = canvasHandleRef.current?.borrowAllLayerPixels();
    if (!layerPixels || layerPixels.size === 0) return null;
    const layerGeo =
      canvasHandleRef.current?.captureAllLayerGeometry() ?? new Map();
    const snap = captureActiveSnapshot();
    const result = new Map<string, string>();
    const tabId = activeTabIdRef.current;
    for (const [id, pixels] of layerPixels) {
      const geo = layerGeo.get(id);
      const lw = geo?.layerWidth ?? snap.canvasWidth;
      const lh = geo?.layerHeight ?? snap.canvasHeight;
      // IMPORTANT: `borrowAllLayerPixels` returns *live* `layer.data` views.
      // For layers pinned to the WASM heap (the brush kernel's zero-copy
      // path), those views become DETACHED if the heap grows later — and
      // since this stash outlives the active tab, a different tab's
      // allocations will detach our reference. `.slice()` returns a fresh
      // JS-heap copy that's immune to growth.
      if ((pixels as unknown) instanceof Float32Array) {
        // rgba32f layer — use compound key to avoid cross-tab collisions
        const storeKey = `${tabId}:${id}`;
        f32TransferStore.set(
          storeKey,
          (pixels as unknown as Float32Array).slice(),
        );
        result.set(id, `data:raw/f32-ref;id=${storeKey}`);
      } else if (pixels.length === lw * lh) {
        // indexed8 layer — 1 byte/pixel palette indices, base64-encode
        const u8 = pixels as Uint8Array;
        const CHUNK = 65535;
        let b64 = "";
        for (let i = 0; i < u8.length; i += CHUNK) {
          b64 += btoa(
            String.fromCharCode(...Array.from(u8.subarray(i, i + CHUNK))),
          );
        }
        result.set(id, `data:raw/indexed8;base64,${b64}`);
      } else {
        // rgba8 layer — use compound key to avoid cross-tab collisions
        const storeKey = `${tabId}:${id}`;
        u8TransferStore.set(storeKey, (pixels as Uint8Array).slice());
        result.set(id, `data:raw/rgba8-ref;id=${storeKey}`);
      }
      if (geo) result.set(`${id}:geo`, JSON.stringify(geo));
    }
    for (const layer of snap.layers) {
      if (!("type" in layer) || layer.type !== "adjustment") continue;
      const maskPixels = canvasHandleRef.current?.getAdjustmentMaskPixels(
        layer.id,
      );
      if (maskPixels) {
        const storeKey = `${tabId}:${layer.id}:mask`;
        // Same WASM-pinned-view detachment hazard as above — copy.
        u8TransferStore.set(storeKey, (maskPixels as Uint8Array).slice());
        result.set(
          `${layer.id}:adjustment-mask`,
          `data:raw/rgba8-ref;id=${storeKey}`,
        );
      }
    }
    return result;
  }, [canvasHandleRef, captureActiveSnapshot]);

  const switchToTab = useCallback(
    (toId: string, tabs_: TabRecord[]): void => {
      const toTab = tabs_.find((t) => t.id === toId);
      if (!toTab) return;
      // Each tab owns its own DocumentScope (selection, history, crop, …).
      // Activating it is enough — no snapshot/restore dance.
      setActiveScope(toTab.scope);
      setActiveTabId(toId);
      displayStore.setEV(toTab.exposureEV ?? 0);
      displayStore.setOperator(toTab.toneMappingOperator ?? "reinhard");
      displayStore.setViewTransformLut(toTab.viewTransformLutId ?? null);
      // Swap palette + groups in the same action that swaps layers/canvas
      // so state never has the outgoing tab's swatchGroups paired with the
      // incoming tab's layers (which would invalidate any group-id-keyed
      // tool state, e.g. the gradient tool's selected swatch group).
      dispatch({
        type: "SWITCH_TAB",
        payload: {
          width: toTab.snapshot.canvasWidth,
          height: toTab.snapshot.canvasHeight,
          backgroundFill: toTab.snapshot.backgroundFill,
          layers: toTab.snapshot.layers,
          activeLayerId: toTab.snapshot.activeLayerId,
          zoom: toTab.snapshot.zoom,
          tiledMode: toTab.tiledMode ?? false,
          showTileGrid: toTab.showTileGrid ?? false,
          pixelFormat: toTab.snapshot.pixelFormat ?? "rgba8",
          swatches: toTab.snapshot.swatches ?? DEFAULT_SWATCHES,
          swatchGroups: toTab.snapshot.swatchGroups ?? [],
        },
      });
      dispatch({
        type: "SET_ANIMATION_MODE",
        payload: toTab.animationMode ?? false,
      });
      dispatch({
        type: "SET_PIXEL_BRUSHES",
        payload: toTab.snapshot.pixelBrushes ?? [],
      });
      dispatch({
        type: "SET_BRUSHES",
        payload: toTab.snapshot.brushes ?? [],
      });
      dispatch({
        type: "SET_ACTIVE_BRUSH",
        payload: toTab.snapshot.activeBrushId ?? null,
      });
      if (toTab.snapshot.spritesheet) {
        dispatch({
          type: "SET_SPRITESHEET",
          payload: toTab.snapshot.spritesheet,
        });
      } else {
        dispatch({
          type: "SET_SPRITESHEET",
          payload: {
            enabled: false,
            animations: [],
            selectedAnimationId: null,
            selectedFrameId: null,
          },
        });
      }
      dispatch({
        type: "SET_PALETTE_ANIMATION",
        payload: toTab.snapshot.paletteAnimation ?? {
          enabled: false,
          fps: 8,
        },
      });
    },
    [dispatch],
  );

  const handleSwitchTab = useCallback(
    (toId: string): void => {
      if (toId === activeTabId) return;
      const snapshot = captureActiveSnapshot();
      const savedLayerData = serializeActiveTabPixels();
      const updated = tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              snapshot,
              savedLayerData,
              tiledMode: state.canvas.tiledMode,
              showTileGrid: state.canvas.showTileGrid,
              exposureEV: displayStore.exposureEV,
              toneMappingOperator: displayStore.toneMappingOperator,
              viewTransformLutId: displayStore.viewTransformLutId,
              animationMode: state.animationMode,
            }
          : t,
      );
      setTabs(updated);
      switchToTab(toId, updated);
    },
    [
      activeTabId,
      tabs,
      captureActiveSnapshot,
      serializeActiveTabPixels,
      switchToTab,
    ],
  );

  const handleCloseTab = useCallback(
    (tabId: string): void => {
      const idx = tabs.findIndex((t) => t.id === tabId);
      const next = tabs.filter((t) => t.id !== tabId);
      setTabs(next);
      if (tabId === activeTabId && next.length > 0) {
        const fallback = next[Math.min(idx, next.length - 1)];
        switchToTab(fallback.id, next);
      }
    },
    [tabs, activeTabId, switchToTab],
  );

  return {
    tabs,
    setTabs,
    activeTabId,
    setActiveTabId,
    activeTabIdRef,
    setTabsRef,
    canvasHandleRef,
    pendingLayerData,
    setPendingLayerData,
    tabCanvasRef,
    captureActiveSnapshot,
    serializeActiveTabPixels,
    switchToTab,
    handleSwitchTab,
    handleCloseTab,
  };
}
