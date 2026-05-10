import { useCallback, useState } from "react";
import type { Dispatch, MutableRefObject } from "react";
import type { AppAction } from "@/core/store/AppContext";
import type { AppState } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { activeScope } from "@/core/store/scope";

export type GuidePreset = "thirds" | "safe-zone" | "center-split" | "fourths";

interface ViewActionsParams {
  dispatch: Dispatch<AppAction>;
  stateRef: MutableRefObject<AppState>;
  canvasHandleRef: { readonly current: CanvasHandle | null };
}

export function useViewActions({
  dispatch,
  stateRef,
  canvasHandleRef,
}: ViewActionsParams) {
  const [findLayersCounter, setFindLayersCounter] = useState(0);

  const handleZoomIn = useCallback(() => {
    dispatch({
      type: "SET_ZOOM",
      payload: parseFloat(
        Math.min(32, stateRef.current.canvas.zoom * 1.25).toFixed(4),
      ),
    });
  }, [dispatch, stateRef]);

  const handleZoomOut = useCallback(() => {
    dispatch({
      type: "SET_ZOOM",
      payload: parseFloat(
        Math.max(0.05, stateRef.current.canvas.zoom * 0.8).toFixed(4),
      ),
    });
  }, [dispatch, stateRef]);

  const handleZoom100 = useCallback(() => {
    dispatch({ type: "SET_ZOOM", payload: 1 });
  }, [dispatch]);

  const handleFitToWindow = useCallback(() => {
    canvasHandleRef.current?.fitToWindow();
  }, [canvasHandleRef]);

  const handleToggleGrid = useCallback(() => {
    dispatch({ type: "TOGGLE_GRID" });
  }, [dispatch]);

  const handleToggleRulers = useCallback(() => {
    dispatch({ type: "TOGGLE_RULERS" });
  }, [dispatch]);

  const handleToggleGuides = useCallback(() => {
    dispatch({ type: "TOGGLE_GUIDES" });
  }, [dispatch]);

  const handleApplyGuidePreset = useCallback(
    (preset: GuidePreset) => {
      const { width: w, height: h } = stateRef.current.canvas;
      if (w === 0 || h === 0) return;
      // Clear existing guides first, then batch-add preset guides
      dispatch({ type: "CLEAR_GUIDES" });
      const add = (axis: "h" | "v", position: number): void => {
        dispatch({
          type: "ADD_GUIDE",
          payload: {
            id: `g${axis}${position}_${Date.now()}_${Math.random()}`,
            axis,
            position,
          },
        });
      };
      if (preset === "thirds") {
        add("v", Math.round(w / 3));
        add("v", Math.round((w * 2) / 3));
        add("h", Math.round(h / 3));
        add("h", Math.round((h * 2) / 3));
      } else if (preset === "fourths") {
        add("v", Math.round(w / 4));
        add("v", Math.round(w / 2));
        add("v", Math.round((w * 3) / 4));
        add("h", Math.round(h / 4));
        add("h", Math.round(h / 2));
        add("h", Math.round((h * 3) / 4));
      } else if (preset === "center-split") {
        add("v", Math.round(w / 2));
        add("h", Math.round(h / 2));
      } else if (preset === "safe-zone") {
        // 10% inset on each side (standard broadcast safe zone)
        const mx = Math.round(w * 0.1);
        const my = Math.round(h * 0.1);
        add("v", mx);
        add("v", w - mx);
        add("h", my);
        add("h", h - my);
      }
    },
    [dispatch, stateRef],
  );

  /**
   * Fit-to-window after a mode change must wait for React to commit the new
   * mode flags AND for the canvas's imperative handle to rebuild against the
   * fresh `tiledMode` / `animationMode` (its dep array picks up `tiledMode`).
   * rAF lands after both, so the fitToWindow call sees the new geometry.
   */
  const fitAfterCommit = useCallback(() => {
    requestAnimationFrame(() => {
      canvasHandleRef.current?.fitToWindow();
    });
  }, [canvasHandleRef]);

  const handleSetNormalMode = useCallback(() => {
    dispatch({ type: "SET_TILED_MODE", payload: false });
    dispatch({ type: "SET_ANIMATION_MODE", payload: false });
    fitAfterCommit();
  }, [dispatch, fitAfterCommit]);

  const handleSetTiledMode = useCallback(() => {
    dispatch({ type: "SET_TILED_MODE", payload: true });
    dispatch({ type: "SET_ANIMATION_MODE", payload: false });
    fitAfterCommit();
  }, [dispatch, fitAfterCommit]);

  const handleToggleTileGrid = useCallback(() => {
    dispatch({
      type: "SET_SHOW_TILE_GRID",
      payload: !stateRef.current.canvas.showTileGrid,
    });
  }, [dispatch, stateRef]);

  const handleSelectAll = useCallback((): void => {
    const { width, height } = stateRef.current.canvas;
    if (width === 0 || height === 0) return;
    activeScope().selection.setRect(0, 0, width - 1, height - 1, "set");
  }, [stateRef]);

  const handleDeselect = useCallback((): void => {
    activeScope().selection.clear();
  }, []);

  const handleSelectAllLayers = useCallback((): void => {
    const allIds = stateRef.current.layers.map((l) => l.id);
    dispatch({ type: "SET_SELECTED_LAYERS", payload: allIds });
  }, [dispatch, stateRef]);

  const handleDeselectLayers = useCallback((): void => {
    dispatch({ type: "SET_SELECTED_LAYERS", payload: [] });
  }, [dispatch]);

  const handleFindLayers = useCallback((): void => {
    setFindLayersCounter((c) => c + 1);
  }, []);

  const handleSetAnimationMode = useCallback(
    (enabled: boolean): void => {
      dispatch({ type: "SET_ANIMATION_MODE", payload: enabled });
      fitAfterCommit();
    },
    [dispatch, fitAfterCommit],
  );

  return {
    findLayersCounter,
    handleZoomIn,
    handleZoomOut,
    handleZoom100,
    handleFitToWindow,
    handleToggleGrid,
    handleToggleRulers,
    handleToggleGuides,
    handleApplyGuidePreset,
    handleSetNormalMode,
    handleSetTiledMode,
    handleToggleTileGrid,
    handleSetAnimationMode,
    handleSelectAll,
    handleDeselect,
    handleSelectAllLayers,
    handleDeselectLayers,
    handleFindLayers,
  };
}
