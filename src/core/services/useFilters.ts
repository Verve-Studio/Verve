import type { AdjustmentType, FilterKey } from "@/types";
import { useCallback } from "react";

interface UseFiltersOptions {
  onCreateFilterAdjLayer: (type: AdjustmentType) => void;
}

export interface UseFiltersReturn {
  /** Apply an "instant" filter (no params dialog) — creates the layer with
   *  default parameters straight away. Driven by the macOS native menu and
   *  the in-app TopBar; per-filter handlers are no longer needed because the
   *  filter menu is built from `effectRegistry`. */
  handleInstantFilter: (key: FilterKey) => void;
}

export function useFilters({
  onCreateFilterAdjLayer,
}: UseFiltersOptions): UseFiltersReturn {
  const handleInstantFilter = useCallback(
    (key: FilterKey): void => {
      onCreateFilterAdjLayer(key as AdjustmentType);
    },
    [onCreateFilterAdjLayer],
  );

  return { handleInstantFilter };
}
