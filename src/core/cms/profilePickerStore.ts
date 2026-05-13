// ─── Profile picker singleton ────────────────────────────────────────────────
//
// Imperative gate for opening the shared `ProfilePickerDialog`. Any caller
// can `await profilePickerStore.request()` to get a Uint8Array of profile
// bytes (or null on cancel) — the dialog itself lives mounted once at the
// top of the tree and consumes the open state.
//
// Used by the four ICC entry points in `useColorProfile` (Assign / Convert
// / Set Display Profile / Set Proof Profile), each of which previously
// called the OS file picker directly. After this push they all route
// through the dialog and get catalog browsing for free, while keeping the
// "Browse File…" escape hatch for one-off picks.

import { useSyncExternalStore } from "react";

interface PendingRequest {
  resolve: (bytes: Uint8Array | null) => void;
}

type Listener = () => void;

class ProfilePickerStore {
  private pending: PendingRequest | null = null;
  private listeners = new Set<Listener>();

  isOpen(): boolean {
    return this.pending !== null;
  }

  /** Open the picker. Returns a promise that resolves with the chosen
   *  profile bytes — either from the catalog or from a one-off file —
   *  or `null` if the user cancelled.
   *
   *  If another request is in flight, the previous one is cancelled
   *  (resolves with `null`) before the new request takes over. */
  request(): Promise<Uint8Array | null> {
    if (this.pending) {
      const prev = this.pending;
      this.pending = null;
      prev.resolve(null);
    }
    return new Promise<Uint8Array | null>((resolve) => {
      this.pending = { resolve };
      this.notify();
    });
  }

  /** Called by the dialog when the user confirms or cancels. Idempotent
   *  if no request is in flight. */
  resolve(bytes: Uint8Array | null): void {
    const p = this.pending;
    this.pending = null;
    this.notify();
    p?.resolve(bytes);
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }
}

export const profilePickerStore = new ProfilePickerStore();

/** React hook: re-renders when the picker is opened or closed. The dialog
 *  uses this to mount its body only while the request is pending. */
export function useProfilePickerOpen(): boolean {
  return useSyncExternalStore(
    (cb) => profilePickerStore.subscribe(cb),
    () => profilePickerStore.isOpen(),
  );
}
