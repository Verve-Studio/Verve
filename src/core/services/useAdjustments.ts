import { effectRegistry } from "@/core/effects";

import type { AppAction } from "@/core/store/AppContext";
import type { AppState, LayerState } from "@/types";
import type { EffectLayerState, EffectParamsMap, EffectType } from "@/core/effects/effectTypes";
import type { Dispatch, MutableRefObject } from "react";
import { useCallback, useMemo } from "react";
import { activeScope } from "@/core/store/scope";
import { newLayerId } from "@/utils/layerId";

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

export interface AddEffectOptions<T extends EffectType = EffectType> {
  /** Layer that owns the effect (must be effect-eligible). */
  parentId: string;
  effectType: T;
  /** Full params (defaults are filled in for missing keys). */
  params?: Partial<EffectParamsMap[T]>;
  name?: string;
  /** Bake the current selection as the effect's mask (default true, as
   *  from the menu). */
  useSelection?: boolean;
  /** Open the effect's panel / editor afterwards (menu behaviour). When
   *  false, the creation is recorded in history right away. */
  openPanel?: boolean;
}

export interface UseAdjustmentsReturn {
  /** Attach an effect to an explicit layer; returns the new effect layer's
   *  id. Throws when the parent can't take effects. */
  addEffect: <T extends EffectType>(options: AddEffectOptions<T>) => string;
  handleCreateAdjustmentLayer: <T extends EffectType>(
    effectType: T,
    paramOverrides?: Partial<EffectParamsMap[T]>,
    /** Layer name (defaults to the effect's label). */
    name?: string,
  ) => void;
  handleCreateColorDitheringWithSetup: (addReduceColors: boolean) => void;
  handleOpenAdjustmentPanel: (layerId: string) => void;
  handleCloseAdjustmentPanel: () => void;
  isAdjustmentMenuEnabled: boolean;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/** Returns true for layer types that can own adjustment/effect children. */
export function isEffectEligibleLayer(layer: LayerState): boolean {
  if ("locked" in layer && (layer as { locked?: boolean }).locked) return false;
  if (!("type" in layer)) return true; // PixelLayerState has no type discriminant
  return (
    layer.type === "text" ||
    layer.type === "shape" ||
    layer.type === "frame" ||
    layer.type === "composite" ||
    layer.type === "linked"
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
    if (openLayerId) activeScope().adjustmentPreview.clear(openLayerId);
    captureHistory("Adjustment");
    dispatch({ type: "SET_OPEN_ADJUSTMENT", payload: null });
  }, [stateRef, captureHistory, dispatch]);

  const addEffect = useCallback(
    <T extends EffectType>({
      parentId,
      effectType,
      params,
      name,
      useSelection = true,
      openPanel = false,
    }: AddEffectOptions<T>): string => {
      const { layers, openAdjustmentLayerId, pixelFormat } = stateRef.current;
      if (pixelFormat === "indexed8") {
        throw new Error("Effects aren't available in indexed-colour documents.");
      }
      const parent = layers.find((l) => l.id === parentId);
      if (!parent) throw new Error("The layer no longer exists.");
      if (!isEffectEligibleLayer(parent)) {
        throw new Error(
          `"${parent.name}" can't take effects (it's locked, or a group, path, mask or effect layer).`,
        );
      }
      const effect = effectRegistry.get(effectType);
      if (!effect) throw new Error(`Unknown effect "${effectType}".`);

      if (openAdjustmentLayerId !== null) {
        activeScope().adjustmentPreview.clear(openAdjustmentLayerId);
        captureHistory("Adjustment");
        dispatch({ type: "SET_OPEN_ADJUSTMENT", payload: null });
      }

      const newId = newLayerId("adj");
      const selPixels = useSelection && getSelectionPixels ? getSelectionPixels() : null;
      const label = name ?? effect.label.replace("…", "");
      const newLayer = {
        id: newId,
        name: label,
        visible: true,
        type: "adjustment" as const,
        parentId,
        effectType,
        params: {
          ...(effect.defaultParams as Record<string, unknown>),
          ...(params ?? {}),
        },
        hasMask: selPixels !== null,
      } as EffectLayerState;

      dispatch({ type: "ADD_ADJUSTMENT_LAYER", payload: newLayer });
      if (selPixels && registerAdjMask) registerAdjMask(newId, selPixels);

      if (!openPanel) {
        captureHistory(label);
      } else if (effect.openEditor?.(newLayer)) {
        // No floating panel to close later, so record the creation now.
        captureHistory(label);
      } else {
        dispatch({ type: "SET_OPEN_ADJUSTMENT", payload: newId });
      }
      return newId;
    },
    [stateRef, captureHistory, dispatch, getSelectionPixels, registerAdjMask],
  );

  const handleCreateAdjustmentLayer = useCallback(
    <T extends EffectType>(
      effectType: T,
      paramOverrides?: Partial<EffectParamsMap[T]>,
      name?: string,
    ): void => {
      const { activeLayerId, layers } = stateRef.current;
      const activeLayer = layers.find((l) => l.id === activeLayerId);
      if (!activeLayer) return;

      // If the active layer is itself an adjustment child, use its parent pixel layer instead
      let parentId: string;
      if (isEffectEligibleLayer(activeLayer)) {
        parentId = activeLayer.id;
      } else if ("type" in activeLayer && activeLayer.type === "adjustment") {
        const parentLayer = layers.find((l) => l.id === activeLayer.parentId);
        if (!parentLayer || !isEffectEligibleLayer(parentLayer)) return;
        parentId = parentLayer.id;
      } else {
        return;
      }
      if (!effectRegistry.get(effectType) || stateRef.current.pixelFormat === "indexed8") return;
      addEffect({ parentId, effectType, params: paramOverrides, name, openPanel: true });
    },
    [stateRef, addEffect],
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
      const layer = stateRef.current.layers.find((l) => l.id === layerId);
      const effect =
        layer && "type" in layer && layer.type === "adjustment"
          ? effectRegistry.get(layer.effectType)
          : undefined;
      if (!effect?.openEditor?.(layer)) {
        dispatch({ type: "SET_OPEN_ADJUSTMENT", payload: layerId });
      }
    },
    [stateRef, dispatch],
  );

  return {
    addEffect,
    handleCreateAdjustmentLayer,
    handleCreateColorDitheringWithSetup,
    handleOpenAdjustmentPanel,
    handleCloseAdjustmentPanel,
    isAdjustmentMenuEnabled,
  };
}
