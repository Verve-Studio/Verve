// ─── useColorProfile ─────────────────────────────────────────────────────────
//
// Hook owning the three ICC-profile commands on the Image menu:
//
//   * `assignProfile`     — pick a .icc/.icm file and assign it to the
//                           document. Tag-only: pixel values are unchanged.
//                           Visual appearance changes because the renderer
//                           reinterprets the same bytes under the new tag.
//   * `convertToProfile`  — pick a .icc/.icm file and convert the document
//                           through lcms2 so the appearance is preserved
//                           under the new tag. Touches every pixel layer.
//   * `removeProfile`     — clear the document's profile tag. The renderer
//                           falls back to the working-space default for
//                           the document's pixel format (sRGB / linear-sRGB).
//
// Indexed8 documents are blocked — palette indices aren't colour values,
// so neither Assign nor Convert applies. Float / 8-bit documents both work.

import { useCallback } from "react";
import type { Dispatch } from "react";
import type { AppAction } from "@/core/store/AppContext";
import type { AppState, PixelFormat } from "@/types";
import type { LutTransform } from "@/core/lut/LUT";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { showOperationError } from "@/utils/userFeedback";
import { notificationStore } from "@/core/store/notificationStore";
import { preferencesStore } from "@/core/store/preferencesStore";
import {
  convertPixels,
  getWorkingSpaceProfile,
  isCmsAvailable,
  type PixelLayout,
  type RenderingIntent,
} from "@/core/cms/lcms2";
import { buildDisplayProfileLut } from "@/core/cms/displayProfile";
import { buildProofLutTransform } from "@/core/cms/proofSetup";
import { profilePickerStore } from "@/core/cms/profilePickerStore";
import {
  parseProfileColorSpace,
  parseProfileDescription,
} from "@/core/cms/iccProfile";
import { displayStore } from "@/ux/main/Canvas/displayStore";

// ─── Hook ────────────────────────────────────────────────────────────────────

interface UseColorProfileOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  state: AppState;
  dispatch: Dispatch<AppAction>;
  captureHistory: (label: string) => void;
}

export interface UseColorProfileReturn {
  assignProfile: () => Promise<void>;
  convertToProfile: () => Promise<void>;
  removeProfile: () => void;
  setDisplayProfile: () => Promise<void>;
  clearDisplayProfile: () => void;
  setProofProfile: () => Promise<void>;
  toggleProofColors: () => void;
  toggleGamutWarning: () => Promise<void>;
  toggleSimulatePaperColor: () => Promise<void>;
  clearProofProfile: () => void;
}

function layoutFor(format: PixelFormat): PixelLayout | null {
  if (format === "rgba8") return "rgba8";
  if (format === "rgba32f") return "rgba32f";
  return null; // indexed8 — no colour management
}

/** Reject profiles that can't legally be applied to an RGB document's
 *  pixel buffer: lcms2 refuses to build an RGBA→RGBA transform when one
 *  side's profile lives in CMYK / Lab / etc., and we'd otherwise surface
 *  a confusing "WASM not built" error from the post-build null-check.
 *  Returns null when the profile is acceptable, or a user-facing string
 *  describing the mismatch when it isn't. */
function rejectIfNotRgb(profileBytes: Uint8Array, role: string): string | null {
  const cs = parseProfileColorSpace(profileBytes);
  if (cs === "rgb" || cs === "gray") return null;
  const name = parseProfileDescription(profileBytes) ?? "the picked profile";
  return (
    `${name} is a ${cs.toUpperCase()} profile and can't be used as a ` +
    `${role} for an RGB document. Pick an RGB profile instead.`
  );
}

/** Open the shared ProfilePickerDialog. Resolves with the chosen profile
 *  bytes (from the catalog or a Browse-File pick) or null on cancel.
 *  Replaces the direct OS-file-dialog flow we used through Tier 2 — the
 *  dialog itself still offers Browse File… as an escape hatch for one-off
 *  picks that aren't worth importing into the catalog. */
function pickProfileBytes(): Promise<Uint8Array | null> {
  return profilePickerStore.request();
}

export function useColorProfile({
  canvasHandleRef,
  state,
  dispatch,
  captureHistory,
}: UseColorProfileOptions): UseColorProfileReturn {
  const assignProfile = useCallback(async (): Promise<void> => {
    if (layoutFor(state.pixelFormat) === null) {
      showOperationError(
        "Cannot assign a profile.",
        "Indexed Color documents don't carry an ICC profile.",
      );
      return;
    }
    try {
      const bytes = await pickProfileBytes();
      if (!bytes) return;
      const mismatch = rejectIfNotRgb(bytes, "document tag");
      if (mismatch) {
        showOperationError("Cannot assign profile.", mismatch);
        return;
      }
      dispatch({ type: "SET_ICC_PROFILE", payload: bytes });
      captureHistory("Assign Profile");
    } catch (err) {
      showOperationError("Could not assign profile.", err);
    }
  }, [state.pixelFormat, dispatch, captureHistory]);

  const convertToProfile = useCallback(async (): Promise<void> => {
    const layout = layoutFor(state.pixelFormat);
    if (layout === null) {
      showOperationError(
        "Cannot convert profile.",
        "Indexed Color documents don't carry an ICC profile.",
      );
      return;
    }
    if (!(await isCmsAvailable())) {
      showOperationError(
        "Color management is not available.",
        "The WASM module wasn't built with lcms2. Drop the lcms2 source into wasm/src/vendor/lcms2/ and run `npm run build:wasm`.",
      );
      return;
    }
    const handle = canvasHandleRef.current;
    if (!handle) return;

    try {
      const dstProfile = await pickProfileBytes();
      if (!dstProfile) return;
      const mismatch = rejectIfNotRgb(dstProfile, "conversion target");
      if (mismatch) {
        showOperationError("Cannot convert to this profile.", mismatch);
        return;
      }

      // Source profile: the document's current tag, or the canonical
      // working-space profile if the document is currently untagged.
      const srcProfile =
        state.iccProfile ?? (await getWorkingSpaceProfile(layout));
      if (!srcProfile) {
        showOperationError(
          "Could not convert profile.",
          "Failed to obtain the source profile.",
        );
        return;
      }

      // Read user-configurable conversion settings.
      const prefs = preferencesStore.get();
      const intent: RenderingIntent = prefs.colorConvertIntent;
      const useBpc = prefs.colorUseBpc;

      // Phase 1: convert every pixel layer's data into a new buffer.
      const newBuffers = new Map<string, Uint8Array | Float32Array>();
      for (const ls of state.layers) {
        // Only plain raster pixel layers carry ICC-managed colour. Text,
        // shape, frame, mask, adjustment layers don't.
        if ("type" in ls) continue;
        const raw = handle.getLayerRawData(ls.id);
        if (!raw) continue;
        const converted = await convertPixels(
          raw,
          srcProfile,
          dstProfile,
          layout,
          intent,
          useBpc,
        );
        if (!converted) {
          // The cms-available check passed at function entry, so this
          // null comes from `cms_create_transform` failing internally —
          // usually a profile pair lcms2 can't bridge. Surface that
          // rather than the misleading "WASM not built" message.
          showOperationError(
            "Could not build color transform.",
            "lcms2 rejected the source/destination profile combination. The picked profile may be incompatible (e.g. CMYK or Lab) or corrupted.",
          );
          return;
        }
        newBuffers.set(ls.id, converted);
      }

      // Phase 2: apply atomically.
      for (const [layerId, newData] of newBuffers) {
        handle.replaceLayerData(layerId, newData, state.pixelFormat, undefined);
      }
      dispatch({ type: "SET_ICC_PROFILE", payload: dstProfile });
      captureHistory("Convert to Profile");
    } catch (err) {
      showOperationError("Could not convert profile.", err);
    }
  }, [
    canvasHandleRef,
    state.pixelFormat,
    state.iccProfile,
    state.layers,
    dispatch,
    captureHistory,
  ]);

  const removeProfile = useCallback((): void => {
    if (!state.iccProfile) return;
    dispatch({ type: "SET_ICC_PROFILE", payload: undefined });
    notificationStore.error(
      "ICC profile removed. The document is now interpreted as the working-space default.",
    );
    captureHistory("Remove Profile");
  }, [state.iccProfile, dispatch, captureHistory]);

  // ── Display profile (Tier 2b) ──────────────────────────────────────────────
  // The display LUT is keyed off the document's working-space layout (sRGB
  // for rgba8, linear-sRGB for rgba32f). Rebuilding when the document
  // format changes is a future enhancement; for now the layout at the
  // time of "Set Display Profile…" is fixed in the LUT.

  const setDisplayProfile = useCallback(async (): Promise<void> => {
    const layout = layoutFor(state.pixelFormat);
    if (layout === null) {
      showOperationError(
        "Cannot set a display profile.",
        "Indexed Color documents don't use the colour-managed display path.",
      );
      return;
    }
    if (!(await isCmsAvailable())) {
      showOperationError(
        "Color management is not available.",
        "The WASM module wasn't built with lcms2. Drop the lcms2 source into wasm/src/vendor/lcms2/ and run `npm run build:wasm`.",
      );
      return;
    }
    try {
      const bytes = await pickProfileBytes();
      if (!bytes) return;
      const mismatch = rejectIfNotRgb(bytes, "display profile");
      if (mismatch) {
        showOperationError("Cannot set display profile.", mismatch);
        return;
      }
      const lut = await buildDisplayProfileLut(bytes, layout);
      if (!lut) {
        showOperationError(
          "Could not build display LUT.",
          "lcms2 returned an empty result — the profile may be corrupted.",
        );
        return;
      }
      displayStore.setDisplayProfile(bytes, lut);
      // Rebuild the active proof LUT (if any) so the new display profile
      // shows up in the chain.
      await rebuildProofLutIfActive(state.pixelFormat);
    } catch (err) {
      showOperationError("Could not set display profile.", err);
    }
  }, [state.pixelFormat]);

  const clearDisplayProfile = useCallback((): void => {
    displayStore.setDisplayProfile(null, null);
    // The proof LUT no longer has a meaningful display target — rebuild
    // against the bundled-sRGB fallback so it still composes correctly.
    void rebuildProofLutIfActive(state.pixelFormat);
  }, [state.pixelFormat]);

  // ── Proof setup (Tier 3a/3b) ───────────────────────────────────────────────

  const setProofProfile = useCallback(async (): Promise<void> => {
    const layout = layoutFor(state.pixelFormat);
    if (layout === null) {
      showOperationError(
        "Cannot set a proof profile.",
        "Indexed Color documents can't be soft-proofed.",
      );
      return;
    }
    if (!(await isCmsAvailable())) {
      showOperationError(
        "Color management is not available.",
        "The WASM module wasn't built with lcms2. Drop the lcms2 source into wasm/src/vendor/lcms2/ and run `npm run build:wasm`.",
      );
      return;
    }
    try {
      const bytes = await pickProfileBytes();
      if (!bytes) return;
      displayStore.setProofProfile(bytes);
      const lut = await composeProofLut(layout);
      displayStore.setProofLut(lut);
      // Picking a proof profile auto-enables Proof Colors so the user
      // sees the effect immediately — matches Photoshop's flow.
      displayStore.setProofEnabled(true);
    } catch (err) {
      showOperationError("Could not set proof profile.", err);
    }
  }, [state.pixelFormat]);

  const toggleProofColors = useCallback((): void => {
    displayStore.setProofEnabled(!displayStore.proofEnabled);
  }, []);

  const toggleGamutWarning = useCallback(async (): Promise<void> => {
    const next = !displayStore.gamutWarningEnabled;
    displayStore.setGamutWarningEnabled(next);
    // Gamut warning is baked into the proof LUT, so rebuild whenever it
    // toggles. The shader doesn't carry a separate gamut-check flag.
    const layout = layoutFor(state.pixelFormat);
    if (layout === null) return;
    const lut = await composeProofLut(layout);
    displayStore.setProofLut(lut);
  }, [state.pixelFormat]);

  const toggleSimulatePaperColor = useCallback(async (): Promise<void> => {
    displayStore.setSimulatePaperColor(!displayStore.simulatePaperColor);
    const layout = layoutFor(state.pixelFormat);
    if (layout === null) return;
    const lut = await composeProofLut(layout);
    displayStore.setProofLut(lut);
  }, [state.pixelFormat]);

  const clearProofProfile = useCallback((): void => {
    displayStore.setProofProfile(null);
    displayStore.setProofLut(null);
  }, []);

  /** Rebuild the proof LUT against the current displayStore + preferences
   *  state. Returns null if no proof profile is active. */
  async function composeProofLut(
    layout: PixelLayout,
  ): Promise<LutTransform | null> {
    const proofBytes = displayStore.proofProfile;
    if (!proofBytes) return null;
    const prefs = preferencesStore.get();
    return buildProofLutTransform(layout, {
      proofProfile: proofBytes,
      displayProfile: displayStore.displayProfileBytes,
      intent: prefs.colorConvertIntent,
      useBpc: prefs.colorUseBpc,
      simulatePaperColor: displayStore.simulatePaperColor,
      gamutCheck: displayStore.gamutWarningEnabled,
      alarmColor: displayStore.gamutWarningColor,
    });
  }

  /** Used when the display profile changes — keeps the proof chain
   *  pointing at the current display target. */
  async function rebuildProofLutIfActive(format: PixelFormat): Promise<void> {
    const layout = layoutFor(format);
    if (layout === null) return;
    if (displayStore.proofProfile === null) return;
    const lut = await composeProofLut(layout);
    displayStore.setProofLut(lut);
  }

  return {
    assignProfile,
    convertToProfile,
    removeProfile,
    setDisplayProfile,
    clearDisplayProfile,
    setProofProfile,
    toggleProofColors,
    toggleGamutWarning,
    toggleSimulatePaperColor,
    clearProofProfile,
  };
}
