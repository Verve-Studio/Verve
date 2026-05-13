import { useSyncExternalStore } from "react";
import type { ToneMappingOperator } from "@/types";
import type { LutTransform } from "@/core/lut/LUT";

// ─── Operator → shader u32 ID mapping ─────────────────────────────────────────

export const OPERATOR_SHADER_ID: Record<ToneMappingOperator, number> = {
  reinhard: 1,
  clamp: 0,
};

// ─── DisplayStore ─────────────────────────────────────────────────────────────
// Module-level singleton. Stores HDR display parameters (EV, tone-mapping
// operator) that are read each frame in the GPU render loop. Kept outside
// React state to avoid re-renders on every EV slider tick.

type Listener = () => void;

class DisplayStore {
  exposureEV: number = 0;
  toneMappingOperator: ToneMappingOperator = "clamp";
  /** id of the LUT (in `lutStore`) used as the canvas-only view transform.
   *  `null` → no view transform (default behaviour: tone-map + sRGB encode
   *  for f32 docs, pass-through for rgba8 docs). View transforms only
   *  affect on-screen display, never exports. */
  viewTransformLutId: string | null = null;

  /** Raw bytes of the active display ICC profile. Kept alongside the
   *  built LUT so soft-proofing (Tier 3a) can chain through to the same
   *  display target via lcms2 without re-parsing or re-picking a file. */
  displayProfileBytes: Uint8Array | null = null;

  /** Display-profile correction LUT (Tier 2b). Built from a user-assigned
   *  ICC profile via `buildDisplayProfileLut`; not stored in `lutStore`
   *  because it's display-machinery, not a user-pickable look. When a
   *  view-transform LUT is also active, that one wins (it already bakes
   *  display encoding). */
  displayProfileLut: LutTransform | null = null;

  // ── Soft proofing (Tier 3a) ────────────────────────────────────────────
  /** Active proof profile bytes (the output device being simulated). When
   *  `null`, soft proofing is unavailable; `proofEnabled` is ignored. */
  proofProfile: Uint8Array | null = null;
  /** Whether "Proof Colors" is currently on. When true, `proofLut`
   *  replaces `displayProfileLut` in the blit pipeline. */
  proofEnabled: boolean = false;
  /** Photoshop's "Simulate Paper Color" — switches the display-leg
   *  intent to Absolute Colorimetric so the proof's white-point /
   *  black-point show through. */
  simulatePaperColor: boolean = false;
  /** Whether gamut warning is on (Tier 3b). Bakes the alarm colour into
   *  the proof LUT for out-of-proof-gamut working-space pixels. */
  gamutWarningEnabled: boolean = false;
  /** Alarm colour for the gamut warning overlay. Default = neutral grey. */
  gamutWarningColor: { r: number; g: number; b: number } = {
    r: 128, g: 128, b: 128,
  };
  /** Composed working → proof → display LUT, rebuilt whenever any of
   *  the above changes via `setProofSetup`. */
  proofLut: LutTransform | null = null;

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): void {
    this.listeners.add(fn);
  }
  unsubscribe(fn: Listener): void {
    this.listeners.delete(fn);
  }
  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  setEV(ev: number): void {
    this.exposureEV = ev;
    this.notify();
  }

  setOperator(op: ToneMappingOperator): void {
    this.toneMappingOperator = op;
    this.notify();
  }

  setViewTransformLut(id: string | null): void {
    this.viewTransformLutId = id;
    this.notify();
  }

  setDisplayProfile(bytes: Uint8Array | null, lut: LutTransform | null): void {
    this.displayProfileBytes = bytes;
    this.displayProfileLut = lut;
    this.notify();
  }

  // ── Soft proofing setters (Tier 3a/3b) ──────────────────────────────────
  // The proof LUT itself is built by the caller via `buildProofLutTransform`
  // and pushed in here — keeping the store free of WASM dependencies and
  // race-free against rebuilds.

  setProofProfile(profile: Uint8Array | null): void {
    this.proofProfile = profile;
    if (profile === null) {
      this.proofEnabled = false;
      this.proofLut = null;
    }
    this.notify();
  }

  setProofEnabled(on: boolean): void {
    // Enabling requires an actual proof profile; silently no-op otherwise so
    // a stale shortcut press doesn't toggle into a useless state.
    if (on && this.proofProfile === null) return;
    this.proofEnabled = on;
    this.notify();
  }

  setSimulatePaperColor(on: boolean): void {
    this.simulatePaperColor = on;
    this.notify();
  }

  setGamutWarningEnabled(on: boolean): void {
    this.gamutWarningEnabled = on;
    this.notify();
  }

  setGamutWarningColor(c: { r: number; g: number; b: number }): void {
    this.gamutWarningColor = { ...c };
    this.notify();
  }

  setProofLut(lut: LutTransform | null): void {
    this.proofLut = lut;
    this.notify();
  }

  /** Reset to defaults (called on tab switch). */
  reset(): void {
    this.exposureEV = 0;
    this.notify();
  }
}

export const displayStore = new DisplayStore();

/** React hook: re-render on any displayStore mutation. Returns the
 *  singleton itself; field access is fine because mutations always go
 *  through `notify()`. Useful for dialogs that need to reflect proof /
 *  display state without manual subscribe boilerplate. */
export function useDisplayStore(): DisplayStore {
  return useSyncExternalStore(
    (cb) => {
      displayStore.subscribe(cb);
      return () => displayStore.unsubscribe(cb);
    },
    () => displayStore,
  );
}
