import type { AppAction } from "@/core/store/AppContext";
import type { RGBAColor } from "@/types";
import { parsePaletteFile, serializePalette } from "@/utils/paletteFormat";
import type { Dispatch } from "react";
import { useCallback, useRef, useState } from "react";

interface UsePaletteFileOpsOptions {
  swatches: RGBAColor[];
  dispatch: Dispatch<AppAction>;
}

export interface UsePaletteFileOpsReturn {
  handleSavePalette: () => Promise<void>;
  handleSavePaletteAs: () => Promise<void>;
  handleOpenPalette: () => Promise<void>;
  paletteError: string | null;
  clearPaletteError: () => void;
}

export function usePaletteFileOps({
  swatches,
  dispatch,
}: UsePaletteFileOpsOptions): UsePaletteFileOpsReturn {
  const lastUsedPathRef = useRef<string | null>(null);
  const [paletteError, setPaletteError] = useState<string | null>(null);

  const clearPaletteError = useCallback(() => setPaletteError(null), []);

  const handleSavePaletteAs = useCallback(async () => {
    const path = await window.api.savePaletteAsDialog(
      lastUsedPathRef.current ?? undefined,
    );
    if (path === null) return;
    try {
      await window.api.writePaletteFile(path, serializePalette(swatches));
      lastUsedPathRef.current = path;
    } catch (e) {
      setPaletteError((e as Error).message);
    }
  }, [swatches]);

  const handleSavePalette = useCallback(async () => {
    if (lastUsedPathRef.current !== null) {
      try {
        await window.api.writePaletteFile(
          lastUsedPathRef.current,
          serializePalette(swatches),
        );
      } catch (e) {
        setPaletteError((e as Error).message);
      }
    } else {
      await handleSavePaletteAs();
    }
  }, [swatches, handleSavePaletteAs]);

  const handleOpenPalette = useCallback(async () => {
    const path = await window.api.openPaletteDialog();
    if (path === null) return;
    try {
      const json = await window.api.readPaletteFile(path);
      const parsed = parsePaletteFile(json);
      dispatch({ type: "SET_SWATCHES", payload: parsed });
      lastUsedPathRef.current = path;
    } catch (e) {
      setPaletteError((e as Error).message);
    }
  }, [dispatch]);

  return {
    handleSavePalette,
    handleSavePaletteAs,
    handleOpenPalette,
    paletteError,
    clearPaletteError,
  };
}
