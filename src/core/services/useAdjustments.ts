import { ADJUSTMENT_REGISTRY } from "@/core/operations/adjustments/registry";
import type { AdjustmentRegistrationEntry } from "@/core/operations/adjustments/registry";
import { adjustmentPreviewStore } from "@/core/store/adjustmentPreviewStore";
import type { AppAction } from "@/core/store/AppContext";
import type {
  AdjustmentLayerState,
  AdjustmentParamsMap,
  AdjustmentType,
  AppState,
  LayerState,
} from "@/types";
import type { Dispatch, MutableRefObject } from "react";
import { useCallback, useMemo } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseAdjustmentsOptions {
  stateRef: MutableRefObject<AppState>;
  captureHistory: (label: string) => void;
  dispatch: Dispatch<AppAction>;
  layers: LayerState[];
  activeLayerId: string | null;
  getSelectionPixels?: () => Uint8Array | null;
  registerAdjMask?: (layerId: string, pixels: Uint8Array) => void;
}

export interface UseAdjustmentsReturn {
  handleCreateAdjustmentLayer: <T extends AdjustmentType>(
    adjustmentType: T,
    paramOverrides?: Partial<AdjustmentParamsMap[T]>,
  ) => void;
  handleCreateColorDitheringWithSetup: (addReduceColors: boolean) => void;
  handleOpenAdjustmentPanel: (layerId: string) => void;
  handleCloseAdjustmentPanel: () => void;
  isAdjustmentMenuEnabled: boolean;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/** Returns true for layer types that can own adjustment/effect children. */
function isEffectEligibleLayer(layer: LayerState): boolean {
  if ("locked" in layer && (layer as { locked?: boolean }).locked) return false;
  if (!("type" in layer)) return true; // PixelLayerState has no type discriminant
  return (
    layer.type === "text" ||
    layer.type === "shape" ||
    layer.type === "composite"
  );
}

export function useAdjustments({
  stateRef,
  captureHistory,
  dispatch,
  layers,
  activeLayerId,
  getSelectionPixels,
  registerAdjMask,
}: UseAdjustmentsOptions): UseAdjustmentsReturn {
  const isAdjustmentMenuEnabled = useMemo(() => {
    const active = layers.find((l) => l.id === activeLayerId);
    if (active == null) return false;
    if (isEffectEligibleLayer(active)) return true;
    // Also allow when an adjustment child layer is active — will use its parent
    if ("type" in active && active.type === "adjustment") {
      const parent = layers.find(
        (l) => l.id === (active as { parentId: string }).parentId,
      );
      return parent != null && isEffectEligibleLayer(parent);
    }
    return false;
  }, [layers, activeLayerId]);

  const handleCloseAdjustmentPanel = useCallback((): void => {
    const openLayerId = stateRef.current.openAdjustmentLayerId;
    if (openLayerId) adjustmentPreviewStore.clear(openLayerId);
    captureHistory("Adjustment");
    dispatch({ type: "SET_OPEN_ADJUSTMENT", payload: null });
  }, [stateRef, captureHistory, dispatch]);

  const handleCreateAdjustmentLayer = useCallback(
    <T extends AdjustmentType>(
      adjustmentType: T,
      paramOverrides?: Partial<AdjustmentParamsMap[T]>,
    ): void => {
      const { activeLayerId, layers, openAdjustmentLayerId } = stateRef.current;

      if (openAdjustmentLayerId !== null) {
        adjustmentPreviewStore.clear(openAdjustmentLayerId);
        captureHistory("Adjustment");
        dispatch({ type: "SET_OPEN_ADJUSTMENT", payload: null });
      }

      const activeLayer = layers.find((l) => l.id === activeLayerId);
      if (!activeLayer) return;

      // If the active layer is itself an adjustment child, use its parent pixel layer instead
      let effectiveParentId: string;
      if (isEffectEligibleLayer(activeLayer)) {
        effectiveParentId = activeLayerId!;
      } else if ("type" in activeLayer && activeLayer.type === "adjustment") {
        const parentId = (activeLayer as { parentId: string }).parentId;
        const parentLayer = layers.find((l) => l.id === parentId);
        if (!parentLayer || !isEffectEligibleLayer(parentLayer)) return;
        effectiveParentId = parentId;
      } else {
        return;
      }

      // Block adding adjustments/effects/filters to locked layers.
      const effectiveParent = layers.find((l) => l.id === effectiveParentId);
      if (
        effectiveParent &&
        "locked" in effectiveParent &&
        (effectiveParent as { locked?: boolean }).locked
      )
        return;

      const entry = (
        ADJUSTMENT_REGISTRY as readonly AdjustmentRegistrationEntry[]
      ).find((e) => e.adjustmentType === adjustmentType);
      if (!entry) return;

      const newId = `adj-${Date.now()}`;
      const selPixels = getSelectionPixels ? getSelectionPixels() : null;
      const hasMask = selPixels !== null;

      const newLayer = {
        id: newId,
        name: entry.label.replace("…", ""),
        visible: true,
        type: "adjustment" as const,
        parentId: effectiveParentId,
        adjustmentType: entry.adjustmentType,
        params: { ...entry.defaultParams, ...(paramOverrides ?? {}) },
        hasMask,
      } as AdjustmentLayerState;

      dispatch({ type: "ADD_ADJUSTMENT_LAYER", payload: newLayer });
      if (!entry.noPanel) {
        dispatch({ type: "SET_OPEN_ADJUSTMENT", payload: newId });
      }

      if (selPixels && registerAdjMask) {
        registerAdjMask(newId, selPixels);
      }
    },
    [stateRef, captureHistory, dispatch, getSelectionPixels, registerAdjMask],
  );

  const handleCreateColorDitheringWithSetup = useCallback(
    (addReduceColors: boolean): void => {
      if (addReduceColors) {
        handleCreateAdjustmentLayer("reduce-colors");
      }
      handleCreateAdjustmentLayer("color-dithering");
    },
    [handleCreateAdjustmentLayer],
  );

  const handleOpenAdjustmentPanel = useCallback(
    (layerId: string): void => {
      dispatch({ type: "SET_ACTIVE_LAYER", payload: layerId });
      dispatch({ type: "SET_OPEN_ADJUSTMENT", payload: layerId });
    },
    [dispatch],
  );

  return {
    handleCreateAdjustmentLayer,
    handleCreateColorDitheringWithSetup,
    handleOpenAdjustmentPanel,
    handleCloseAdjustmentPanel,
    isAdjustmentMenuEnabled,
  };
}
