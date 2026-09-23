import type { AppState, FilterKey } from "@/types";
import type { EffectType } from "@/core/effects/effectTypes";
import type { UseAdjustmentsReturn } from "@/core/services/useAdjustments";
import { useCallback } from "react";

interface UseFiltersOptions {
  adjustments: UseAdjustmentsReturn;
  /** Live app state; colours are read when a filter is created. */
  getState: () => AppState;
  /** Wraps every filter-creation action so that an in-flight free-transform
   *  is committed/cancelled before mutating the layer stack. */
  requireTransformDecision: (action: () => void) => void;
}

export interface UseFiltersReturn {
  /** Apply an "instant" filter (no params dialog) — creates the layer with
   *  default parameters straight away. Driven by the macOS native menu and
   *  the in-app TopBar; per-filter handlers are no longer needed because the
   *  filter menu is built from `effectRegistry`. */
  handleInstantFilter: (key: FilterKey) => void;
  /** Create a filter / effect / adjustment layer of the given type. Seeds
   *  randomness for noise-based effects and seeds the primary/secondary
   *  colours for `clouds`. */
  onCreateFilterAdjLayer: (type: EffectType) => void;
  /** Open the panel for an effect by `FilterKey` — currently identical to
   *  `onCreateFilterAdjLayer` but kept as a separate entry point so the
   *  callsites keep their semantic distinction. */
  handleOpenFilterDialog: (key: FilterKey) => void;
}

export function useFilters({
  adjustments,
  getState,
  requireTransformDecision,
}: UseFiltersOptions): UseFiltersReturn {
  const onCreateFilterAdjLayer = useCallback(
    (type: EffectType): void => {
      requireTransformDecision(() => {
        if (type === "clouds") {
          const { primaryColor, secondaryColor } = getState();
          const { r: fgR, g: fgG, b: fgB } = primaryColor;
          const { r: bgR, g: bgG, b: bgB } = secondaryColor;
          adjustments.handleCreateAdjustmentLayer("clouds", {
            seed: (Math.random() * 0xffffffff) >>> 0,
            fgR,
            fgG,
            fgB,
            bgR,
            bgG,
            bgB,
          });
          return;
        }
        if (type === "add-noise" || type === "film-grain") {
          adjustments.handleCreateAdjustmentLayer(type, {
            seed: (Math.random() * 0xffffffff) >>> 0,
          });
          return;
        }
        adjustments.handleCreateAdjustmentLayer(type);
      });
    },
    [adjustments, requireTransformDecision, getState],
  );

  const handleInstantFilter = useCallback(
    (key: FilterKey): void => {
      onCreateFilterAdjLayer(key as EffectType);
    },
    [onCreateFilterAdjLayer],
  );

  const handleOpenFilterDialog = useCallback(
    (key: FilterKey): void => {
      requireTransformDecision(() => {
        onCreateFilterAdjLayer(key as EffectType);
      });
    },
    [requireTransformDecision, onCreateFilterAdjLayer],
  );

  return { handleInstantFilter, onCreateFilterAdjLayer, handleOpenFilterDialog };
}
