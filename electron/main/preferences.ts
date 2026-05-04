import { app, ipcMain } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * App-wide user preferences persisted to userData/preferences.json.
 * Keep this object FLAT and JSON-serializable. Add new fields here and bump
 * defaults; the loader fills in any missing fields from DEFAULT_PREFERENCES
 * so old config files remain forward-compatible.
 */
export interface AppPreferences {
  /** Maximum total bytes the in-memory undo history is allowed to use. */
  historyMemoryBytes: number
}

const DEFAULT_PREFERENCES: AppPreferences = {
  // 4 GB default — generous on modern machines, tight enough that the
  // eviction path runs in normal use on multi-GB-per-layer documents.
  historyMemoryBytes: 4 * 1024 * 1024 * 1024,
}

function prefsPath(): string {
  return join(app.getPath('userData'), 'preferences.json')
}

function mergeWithDefaults(partial: Partial<AppPreferences>): AppPreferences {
  return { ...DEFAULT_PREFERENCES, ...partial }
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

export function registerPreferencesHandlers(): void {
  ipcMain.handle('prefs:load', async (): Promise<AppPreferences> => {
    try {
      const raw = await readFile(prefsPath(), 'utf-8')
      const parsed = JSON.parse(raw) as Partial<AppPreferences>
      return mergeWithDefaults(parsed)
    } catch {
      return { ...DEFAULT_PREFERENCES }
    }
  })

  ipcMain.handle('prefs:save', async (_event, prefs: AppPreferences): Promise<void> => {
    const merged = mergeWithDefaults(prefs)
    await writeFile(prefsPath(), JSON.stringify(merged, null, 2), 'utf-8')
  })
}
