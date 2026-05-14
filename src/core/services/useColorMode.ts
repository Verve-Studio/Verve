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
import { notificationStore } from "@/core/store/notificationStore";
import {
  convertRgba8ToF32,
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

/** Convert raw pixel data from one format to another. For `rgba8 → rgba32f`
 *  the result is **scene-linear** floats (CLAUDE.md's "rgba32f = linear
 *  light" rule). When `sourceColorSpace` is `'auto'` / `'srgb'` / undefined
 *  we apply the sRGB transfer function so the float buffer matches what
 *  lcms2's working profile, Convert to Profile, and file I/O all assume.
 *  For log / linear / wide-gamut sources we keep a non-destructive `/255`
 *  promotion — those signals don't carry the sRGB curve and the renderer's
 *  inline IDT pre-pass decodes them at composite time via the layer's
 *  `colorSpace` tag. */
async function convertBuffer(
  data: Uint8Array | Float32Array,
  fromFormat: PixelFormat,
  toFormat: PixelFormat,
  palette: RGBAColor[],
  sourceColorSpace?: LayerColorSpace,
): Promise<Uint8Array | Float32Array> {
  if (fromFormat === toFormat) return data;

  if (fromFormat === "rgba8" && toFormat === "rgba32f") {
    const isSrgbSource =
      sourceColorSpace === undefined ||
      sourceColorSpace === "auto" ||
      sourceColorSpace === "srgb";
    return isSrgbSource
      ? convertRgba8ToF32(data as Uint8Array)
      : convertRgba8ToF32Raw(data as Uint8Array);
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

      // Indexed8 carries palette indices, not colour values — an attached
      // ICC profile is meaningless in that mode (every modern app strips
      // it on conversion). Drop the profile and surface a one-shot notice
      // so the user knows the round-trip won't preserve it.
      if (toFormat === "indexed8" && state.iccProfile) {
        dispatch({ type: "SET_ICC_PROFILE", payload: undefined });
        notificationStore.error(
          "Embedded ICC profile dropped on conversion to Indexed Color.",
        );
      }

      // rgba8 → rgba32f rewrites every pixel: Auto / sRGB sources are
      // gamma-decoded to scene-linear, log / linear / wide-gamut sources
      // are non-destructively promoted but no longer carry the document's
      // old sRGB-encoded interpretation. Either way, the previous ICC tag
      // (typically `sRGB` from import) no longer matches the buffer — a
      // later Convert to Profile would otherwise re-apply the sRGB decode
      // through lcms2 and crush the image by ~12× in shadows. Clear it so
      // the document falls back to the rgba32f working space (linear-sRGB)
      // which is what the bytes actually encode.
      if (
        fromFormat === "rgba8" &&
        toFormat === "rgba32f" &&
        state.iccProfile
      ) {
        dispatch({ type: "SET_ICC_PROFILE", payload: undefined });
      }

      // Tag every converted pixel layer so the renderer's inline IDT
      // interprets the float values correctly. For Auto / sRGB sources we
      // already gamma-decoded inside `convertBuffer`, so the data is
      // scene-linear and the layer is tagged `'linear-srgb'` (the renderer
      // skips its decode). For log / wide-gamut / already-linear sources
      // we left the bytes promoted untouched and forward the user-declared
      // tag so the renderer's IDT pre-pass can do the decode.
      if (fromFormat === "rgba8" && toFormat === "rgba32f") {
        const isSrgbSource =
          sourceColorSpace === undefined ||
          sourceColorSpace === "auto" ||
          sourceColorSpace === "srgb";
        const tag: LayerColorSpace = isSrgbSource
          ? "linear-srgb"
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
