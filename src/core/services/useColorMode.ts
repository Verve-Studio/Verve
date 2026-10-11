import type { AppShellState } from "@/core/store/AppContext";
import { useCallback } from "react";
import type { Dispatch } from "react";
import type { AppAction } from "@/core/store/AppContext";
import type {
  LayerColorSpace,
  PixelFormat,
  RGBAColor,
  Tool,
} from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { showOperationError } from "@/utils/userFeedback";
import type { TransformCallOptions } from "./useCanvasTransforms";
import { notificationStore } from "@/core/store/notificationStore";
import { convertPixelBuffer } from "@/utils/convertPixelBuffer";

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
  state: AppShellState;
  dispatch: Dispatch<AppAction>;
  captureHistory: (label: string) => void;
  /** Remounts the canvas in `toFormat`, hydrating each converted layer
   *  from `converted` (layer id → buffer in `toFormat`). */
  onFormatChangeRequiresRemount: (
    toFormat: PixelFormat,
    converted: ReadonlyMap<string, Uint8Array | Float32Array>,
  ) => void;
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
    opts?: TransformCallOptions,
  ) => Promise<void>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns true for plain raster pixel layers (no type discriminant). */
function isPixelLayer(layer: { id: string; [key: string]: unknown }): boolean {
  return !("type" in layer);
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
      opts?: TransformCallOptions,
    ): Promise<void> => {
      /** Report to the user, or throw for programmatic callers. */
      const fail = (title: string, detail: unknown): void => {
        if (opts?.throwErrors) {
          throw detail instanceof Error ? detail : new Error(`${title} ${String(detail)}`);
        }
        showOperationError(title, detail);
      };
      const fromFormat = state.pixelFormat;
      if (toFormat === fromFormat) return;

      const handle = canvasHandleRef.current;
      if (!handle) return fail("Color mode conversion failed.", "The canvas isn't ready yet.");

      if (toFormat === "indexed8" && state.swatches.length === 0) {
        fail(
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
        // The live layer view, not a copy: every conversion reads it
        // synchronously at call time (the WASM palette match reads a
        // heap-resident view in place) and never writes it.
        const raw = handle.getGpuLayer(ls.id)?.data;
        if (!raw) continue;
        try {
          const converted = await convertPixelBuffer(
            raw,
            fromFormat,
            toFormat,
            palette,
            sourceColorSpace,
          );
          conversions.set(ls.id, converted);
        } catch (err) {
          fail("Color mode conversion failed.", err);
          return; // abort — no layers have been modified yet
        }
      }

      // ── Phase 2: Apply all conversions ────────────────────────────────────
      // Applied to the current canvas even when a remount follows: the
      // "Convert Color Mode" history entry is captured from it. The remount
      // then hydrates from `conversions` (same content) instead of copying
      // every layer back out of the canvas.
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
      // already gamma-decoded inside `convertPixelBuffer`, so the data is
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
        onFormatChangeRequiresRemount(toFormat, conversions);
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
