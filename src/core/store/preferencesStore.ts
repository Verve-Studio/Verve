/**
 * Module-level singleton for app-wide user preferences.
 *
 * Pattern mirrors `historyStore` / `selectionStore`: imperative `.set()`,
 * `.get()`, `.subscribe()` API. Components observe via `usePreferences()`.
 *
 * Persistence: backed by `userData/preferences.json` via the main process
 * (see `electron/main/preferences.ts`). `set()` writes through asynchronously;
 * we don't await — the in-memory value is the source of truth at runtime.
 */
import { useSyncExternalStore } from 'react'

export interface AppPreferences {
  /** Maximum total bytes the in-memory undo history is allowed to use. */
  historyMemoryBytes: number
}

const DEFAULT_PREFERENCES: AppPreferences = {
  historyMemoryBytes: 4 * 1024 * 1024 * 1024,  // 4 GB
}

class PreferencesStore {
  private value: AppPreferences = { ...DEFAULT_PREFERENCES }
  private listeners = new Set<() => void>()
  private loaded = false

  /** Snapshot of current preferences. Stable identity until a `set()`/`load()`. */
  get(): AppPreferences {
    return this.value
  }

  /**
   * Hydrate from disk. Call once at app startup before any component reads
   * the store. Safe to call again — subsequent calls overwrite the in-memory
   * value with what's on disk.
   */
  async load(): Promise<void> {
    try {
      const fromDisk = await window.api.loadPreferences()
      this.value = { ...DEFAULT_PREFERENCES, ...fromDisk }
    } catch {
      this.value = { ...DEFAULT_PREFERENCES }
    }
    this.loaded = true
    this.notify()
  }

  isLoaded(): boolean {
    return this.loaded
  }

  /**
   * Mutate one or more preference fields. Updates the in-memory snapshot
   * immediately, notifies subscribers, then persists to disk asynchronously.
   * Disk write failures are intentionally swallowed — the app stays usable.
   */
  set(patch: Partial<AppPreferences>): void {
    this.value = { ...this.value, ...patch }
    this.notify()
    void window.api.savePreferences(this.value).catch(() => {})
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(): void {
    this.listeners.forEach(cb => cb())
  }
}

export const preferencesStore = new PreferencesStore()

/** React hook: subscribe to the preferences store and re-render on change. */
export function usePreferences(): AppPreferences {
  return useSyncExternalStore(
    cb => preferencesStore.subscribe(cb),
    () => preferencesStore.get(),
  )
}
