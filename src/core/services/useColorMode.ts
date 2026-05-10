import { useCallback } from "react";
import type { Dispatch } from "react";
import type { AppAction } from "@/core/store/AppContext";
import type {
  AppState,
  LayerColorSpace,
  PixelFormat,
  RGBAColor,
  Tool,
} from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { showOperationError } from "@/utils/userFeedback";
import {
  convertRgba8ToF32Raw,
  convertF32ToRgba8,
  convertIndexedToRgba8,
  convertIndexedToF32,
} from "@/utils/pixelFormatConvert";
import { matchPaletteIndices } from "@/wasm";

// ─── Types ────────────────────────────────────────────────────────────────────

const INDEXED8_DISABLED_TOOLS = new Set<Tool>([
  "brush",
  "gradient",
  "clone-stamp",
  "dodge",
  "burn",
]);

interface UseColorModeOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  state: AppState;
  dispatch: Dispatch<AppAction>;
  captureHistory: (label: string) => void;
  onFormatChangeRequiresRemount: (toFormat: PixelFormat) => void;
  onRequestConversionDialog: (toFormat: PixelFormat) => void;
}

export interface UseColorModeReturn {
  handleConvertColorMode: (toFormat: PixelFormat) => void;
  /** When converting rgba8 → rgba32f, `sourceColorSpace` lets the caller
   *  declare what the rgba8 bytes actually encode. `'auto'` / `'srgb'` use
   *  the standard sRGB → linear gamma decode (default for everyday
   *  content). Camera log spaces (`'slog3'`, `'logc3'`, …) and
   *  `'linear-srgb'` skip the decode and tag each converted pixel layer
   *  so the renderer's IDT pre-pass can interpret it correctly. Ignored
   *  for any other conversion direction. */
  executeConversion: (
    toFormat: PixelFormat,
    sourceColorSpace?: LayerColorSpace,
  ) => Promise<void>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns true for plain raster pixel layers (no type discriminant). */
function isPixelLayer(layer: { id: string; [key: string]: unknown }): boolean {
  return !("type" in layer);
}

/** Convert raw pixel data from one format to another. The rgba8 → rgba32f
 *  path is **non-destructive**: bytes are promoted to floats via `/255`
 *  with no transfer-function decode. The renderer's inline IDT (driven by
 *  the layer's `colorSpace` tag) is the single place colour-space
 *  conversion happens. The `sourceColorSpace` parameter is plumbed through
 *  for symmetry and future use; it doesn't affect the conversion math but
 *  is used by the caller to tag the resulting layer. */
async function convertBuffer(
  data: Uint8Array | Float32Array,
  fromFormat: PixelFormat,
  toFormat: PixelFormat,
  palette: RGBAColor[],
  _sourceColorSpace?: LayerColorSpace,
): Promise<Uint8Array | Float32Array> {
  if (fromFormat === toFormat) return data;

  if (fromFormat === "rgba8" && toFormat === "rgba32f") {
    return convertRgba8ToF32Raw(data as Uint8Array);
  }
  if (fromFormat === "rgba32f" && toFormat === "rgba8") {
    return convertF32ToRgba8(data as Float32Array);
  }
  if (fromFormat === "rgba8" && toFormat === "indexed8") {
    return matchPaletteIndices(data as Uint8Array, palette);
  }
  if (fromFormat === "indexed8" && toFormat === "rgba8") {
    return convertIndexedToRgba8(data as Uint8Array, palette);
  }
  if (fromFormat === "rgba32f" && toFormat === "indexed8") {
    const rgba8 = convertF32ToRgba8(data as Float32Array);
    return matchPaletteIndices(rgba8, palette);
  }
  if (fromFormat === "indexed8" && toFormat === "rgba32f") {
    return convertIndexedToF32(data as Uint8Array, palette);
  }
  return data;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useColorMode({
  canvasHandleRef,
  state,
  dispatch,
  captureHistory,
  onFormatChangeRequiresRemount,
  onRequestConversionDialog,
}: UseColorModeOptions): UseColorModeReturn {
  const handleConvertColorMode = useCallback(
    (toFormat: PixelFormat): void => {
      if (toFormat === state.pixelFormat) return;
      if (toFormat === "indexed8" && state.swatches.length === 0) {
        showOperationError(
          "Cannot convert to Indexed/8.",
          "The palette is empty. Add swatches first.",
        );
        return;
      }
      onRequestConversionDialog(toFormat);
    },
    [state.pixelFormat, state.swatches.length, onRequestConversionDialog],
  );

  const executeConversion = useCallback(
    async (
      toFormat: PixelFormat,
      sourceColorSpace?: LayerColorSpace,
    ): Promise<void> => {
      const fromFormat = state.pixelFormat;
      if (toFormat === fromFormat) return;

      const handle = canvasHandleRef.current;
      if (!handle) return;

      if (toFormat === "indexed8" && state.swatches.length === 0) {
        showOperationError(
          "Cannot convert to Indexed/8.",
          "The palette is empty. Add swatches first.",
        );
        return;
      }

      const palette: RGBAColor[] = state.swatches;

      // ── Phase 1: Pre-allocate all output buffers (atomicity) ──────────────
      const conversions = new Map<string, Uint8Array | Float32Array>();
      for (const ls of state.layers) {
        if (
          !isPixelLayer(ls as unknown as { id: string; [key: string]: unknown })
        )
          continue;
        const raw = handle.getLayerRawData(ls.id);
        if (!raw) continue;
        try {
          const converted = await convertBuffer(
            raw,
            fromFormat,
            toFormat,
            palette,
            sourceColorSpace,
          );
          conversions.set(ls.id, converted);
        } catch (err) {
          showOperationError("Color mode conversion failed.", err);
          return; // abort — no layers have been modified yet
        }
      }

      // ── Phase 2: Apply all conversions ────────────────────────────────────
      for (const [layerId, newData] of conversions) {
        handle.replaceLayerData(
          layerId,
          newData,
          toFormat,
          toFormat === "indexed8" ? palette : undefined,
        );
      }

      if (
        toFormat === "indexed8" &&
        INDEXED8_DISABLED_TOOLS.has(state.activeTool)
      ) {
        dispatch({ type: "SET_TOOL", payload: "pencil" });
      }

      dispatch({ type: "SET_PIXEL_FORMAT", payload: toFormat });

      // Tag every converted pixel layer with the user-declared source space
      // so the renderer's inline IDT interprets the float values correctly.
      // The conversion was a non-destructive `/255` promotion — the float
      // values still encode the original byte signal, and the tag tells
      // the renderer how to decode them at composite time.
      //
      // `'auto'` resolves to `'linear-srgb'` on an rgba32f layer, which
      // would skip the decode and render the sRGB-promoted floats as if
      // they were already linear (wrong colours). When the user picked
      // Auto / sRGB we must explicitly tag the result `'srgb'`.
      if (fromFormat === "rgba8" && toFormat === "rgba32f") {
        const tag: LayerColorSpace =
          sourceColorSpace === undefined || sourceColorSpace === "auto"
            ? "srgb"
            : sourceColorSpace;
        for (const layerId of conversions.keys()) {
          dispatch({
            type: "SET_LAYER_COLOR_SPACE",
            payload: { id: layerId, colorSpace: tag },
          });
        }
      }

      const involvesF32 = fromFormat === "rgba32f" || toFormat === "rgba32f";
      if (involvesF32) {
        onFormatChangeRequiresRemount(toFormat);
      } else {
        captureHistory("Convert Color Mode");
      }
    },
    [
      canvasHandleRef,
      state,
      dispatch,
      captureHistory,
      onFormatChangeRequiresRemount,
    ],
  );

  return { handleConvertColorMode, executeConversion };
}
