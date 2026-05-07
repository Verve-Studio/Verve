import type { EffectParamsMap, CurvesPreset } from "@/types";
import { useCallback, useEffect, useState } from "react";

interface UseCurvesPresetsState {
  presets: CurvesPreset[];
  isLoading: boolean;
  error: string | null;
}

interface UseCurvesPresetsReturn extends UseCurvesPresetsState {
  savePreset: (
    name: string,
    curvesParams: EffectParamsMap["curves"],
  ) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
  renamePreset: (id: string, newName: string) => Promise<void>;
}

/**
 * Hook for managing custom Curves presets.
 * Loads presets from app userData on mount and provides CRUD operations.
 * Presets persist across app restarts.
 */
export function useCurvesPresets(): UseCurvesPresetsReturn {
  const [state, setState] = useState<UseCurvesPresetsState>({
    presets: [],
    isLoading: true,
    error: null,
  });

  // Load presets on mount
  useEffect(() => {
    const loadPresets = async (): Promise<void> => {
      try {
        const loaded = await window.api.loadCurvesPresets();
        setState({
          presets: loaded,
          isLoading: false,
          error: null,
        });
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : "Failed to load presets";
        console.error("Failed to load curves presets:", err);
        setState({
          presets: [],
          isLoading: false,
          error: errorMsg,
        });
      }
    };

    loadPresets();
  }, []);

  const savePresets = useCallback(
    async (presets: CurvesPreset[]): Promise<void> => {
      try {
        await window.api.saveCurvesPresets(presets);
        setState((prev) => ({ ...prev, presets, error: null }));
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : "Failed to save presets";
        console.error("Failed to save curves presets:", err);
        setState((prev) => ({ ...prev, error: errorMsg }));
      }
    },
    [],
  );

  const savePreset = useCallback(
    async (
      name: string,
      curvesParams: EffectParamsMap["curves"],
    ): Promise<void> => {
      // Generate unique ID using timestamp + random suffix
      const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      const newPreset: CurvesPreset = {
        id,
        name,
        channels: curvesParams.channels,
      };

      const updated = [...state.presets, newPreset];
      await savePresets(updated);
    },
    [state.presets, savePresets],
  );

  const deletePreset = useCallback(
    async (id: string): Promise<void> => {
      const updated = state.presets.filter((p) => p.id !== id);
      await savePresets(updated);
    },
    [state.presets, savePresets],
  );

  const renamePreset = useCallback(
    async (id: string, newName: string): Promise<void> => {
      const updated = state.presets.map((p) =>
        p.id === id ? { ...p, name: newName } : p,
      );
      await savePresets(updated);
    },
    [state.presets, savePresets],
  );

  return {
    presets: state.presets,
    isLoading: state.isLoading,
    error: state.error,
    savePreset,
    deletePreset,
    renamePreset,
  };
}
