/**
 * Module-level singleton for app-wide user preferences.
 *
 * Pattern mirrors `activeScope().history` / `activeScope().selection`: imperative `.set()`,
 * `.get()`, `.subscribe()` API. Components observe via `usePreferences()`.
 *
 * Persistence: backed by `userData/preferences.json` via the main process
 * (see `electron/main/preferences.ts`). `set()` writes through asynchronously;
 * we don't await — the in-memory value is the source of truth at runtime.
 */
import { useSyncExternalStore } from "react";

/** Theme selection. "auto" follows the host OS via prefers-color-scheme. */
export type ThemePreference = "light" | "dark" | "auto";

export interface AppPreferences {
  /** Visual theme. Applied via the `data-theme` attribute on <html>. */
  theme: ThemePreference;
  /** Maximum total bytes the in-memory undo history is allowed to use. */
  historyMemoryBytes: number;
  /**
   * Soft cap (bytes) on total tracked buffer + texture memory across the
   * whole app. Allocations exceeding it are rejected with an error.
   * Ignored when `bufferMemoryMaxOut` is true.
   */
  bufferMemoryBytes: number;
  /** When true, the buffer-memory cap is ignored — allocate until the OS fails. */
  bufferMemoryMaxOut: boolean;
  /**
   * Whether the system has unified memory (integrated GPU / Apple Silicon).
   * When true, GPU texture allocations count against the same cap as CPU
   * buffer allocations — they share physical RAM. When false, GPU
   * allocations are tracked for diagnostics but are not capped (they live
   * in dedicated VRAM).
   *
   * Defaults from `process.platform` at first launch (`darwin` → true).
   * Users can flip it manually in Preferences if the auto-detect is wrong
   * (e.g. a Mac with an external GPU, or a Windows laptop with only
   * integrated Intel/AMD graphics).
   */
  unifiedMemory: boolean;
}

const DEFAULT_PREFERENCES: AppPreferences = {
  theme: "dark",
  historyMemoryBytes: 4 * 1024 * 1024 * 1024, // 4 GB
  bufferMemoryBytes: 8 * 1024 * 1024 * 1024, // 8 GB
  bufferMemoryMaxOut: false,
  // Auto-detected on first launch in `load()`; this is just the conservative
  // fallback used before that runs (treat as discrete to avoid over-capping).
  unifiedMemory: false,
};

class PreferencesStore {
  private value: AppPreferences = { ...DEFAULT_PREFERENCES };
  private listeners = new Set<() => void>();
  private loaded = false;

  /** Snapshot of current preferences. Stable identity until a `set()`/`load()`. */
  get(): AppPreferences {
    return this.value;
  }

  /**
   * Hydrate from disk. Call once at app startup before any component reads
   * the store. Safe to call again — subsequent calls overwrite the in-memory
   * value with what's on disk.
   */
  async load(): Promise<void> {
    try {
      const fromDisk = await window.api.loadPreferences();
      // If `unifiedMemory` was never persisted (first launch / older config),
      // seed it from the host platform — macOS = unified, everything else
      // assumed discrete. The user can override this in Preferences.
      const defaults = { ...DEFAULT_PREFERENCES };
      if (fromDisk.unifiedMemory === undefined) {
        defaults.unifiedMemory = window.api.platform === "darwin";
      }
      this.value = { ...defaults, ...fromDisk };
    } catch {
      this.value = {
        ...DEFAULT_PREFERENCES,
        unifiedMemory: window.api.platform === "darwin",
      };
    }
    this.loaded = true;
    this.notify();
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Mutate one or more preference fields. Updates the in-memory snapshot
   * immediately, notifies subscribers, then persists to disk asynchronously.
   * Disk write failures are intentionally swallowed — the app stays usable.
   */
  set(patch: Partial<AppPreferences>): void {
    this.value = { ...this.value, ...patch };
    this.notify();
    void window.api.savePreferences(this.value).catch(() => {});
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }
}

export const preferencesStore = new PreferencesStore();

/**
 * Mirror the active theme preference onto `<html data-theme="…">`.  CSS in
 * global.scss reads this attribute (plus prefers-color-scheme for "auto") to
 * pick the light or dark palette.
 *
 * Call once at startup, after `preferencesStore.load()`, then forget — the
 * subscription keeps the attribute in sync for the lifetime of the page.
 */
export function applyThemePreference(): () => void {
  const root = document.documentElement;
  const update = (): void => {
    root.dataset.theme = preferencesStore.get().theme;
  };
  update();
  return preferencesStore.subscribe(update);
}

/** React hook: subscribe to the preferences store and re-render on change. */
export function usePreferences(): AppPreferences {
  return useSyncExternalStore(
    (cb) => preferencesStore.subscribe(cb),
    () => preferencesStore.get(),
  );
}
