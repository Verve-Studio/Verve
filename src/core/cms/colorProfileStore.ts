// ─── Color profile catalog (Tier 3d) ─────────────────────────────────────────
//
// Renderer-side cache of the OS + user-imported ICC profile listing the
// main process maintains. Loaded lazily on first read; refreshed whenever
// the user imports or deletes a profile.
//
// This store deliberately doesn't keep the raw bytes — those stay on disk
// and are fetched on demand via `readProfileBytes(id)` when the user
// actually picks a profile from the manager. Reading every profile up
// front would cost ~MBs of memory for nothing.

import { useSyncExternalStore } from "react";

export interface ProfileCatalogEntry {
  id: string;
  filename: string;
  source: "system" | "user";
  size: number;
}

type Listener = () => void;

class ColorProfileStore {
  private entries: ProfileCatalogEntry[] = [];
  private loaded = false;
  private loading: Promise<void> | null = null;
  private listeners = new Set<Listener>();

  /** Snapshot of the current catalog. Empty until `refresh()` resolves
   *  the first time. */
  list(): ProfileCatalogEntry[] {
    return this.entries;
  }

  /** True once at least one refresh has resolved (the manager dialog
   *  uses this to show a "Loading…" state on first open). */
  isLoaded(): boolean {
    return this.loaded;
  }

  /** Re-scan the main process for available profiles. Idempotent — an
   *  in-flight refresh is reused. */
  async refresh(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const list = await window.api.cmsListProfiles();
        this.entries = list;
        this.loaded = true;
      } catch {
        this.entries = [];
        this.loaded = true;
      } finally {
        this.loading = null;
        this.notify();
      }
    })();
    return this.loading;
  }

  /** Open the OS file picker, copy the chosen profile into Verve's user
   *  profile directory, and refresh. Returns the newly-added entry's id
   *  on success (or null on cancel / failure). */
  async importFromFile(): Promise<string | null> {
    const entry = await window.api.cmsImportProfileDialog();
    if (!entry) return null;
    await this.refresh();
    return entry.id;
  }

  /** Delete a user-imported profile. System profiles are read-only and
   *  silently rejected. Returns true if a file was removed. */
  async deleteUser(id: string): Promise<boolean> {
    const ok = await window.api.cmsDeleteUserProfile(id);
    if (ok) await this.refresh();
    return ok;
  }

  /** Fetch the raw bytes of a profile (system or user) by id. */
  async readBytes(id: string): Promise<Uint8Array | null> {
    const base64 = await window.api.cmsReadProfileBytes(id);
    if (!base64) return null;
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }
}

export const colorProfileStore = new ColorProfileStore();

/** React hook: subscribe to the catalog. Triggers a refresh on first
 *  use so opening the manager dialog doesn't require a manual call. */
export function useColorProfileCatalog(): ProfileCatalogEntry[] {
  return useSyncExternalStore(
    (cb) => colorProfileStore.subscribe(cb),
    () => colorProfileStore.list(),
  );
}
