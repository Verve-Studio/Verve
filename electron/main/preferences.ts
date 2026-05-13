import { app, ipcMain } from 'electron'
import { totalmem } from 'node:os'
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
  /** UI theme: "light" | "dark" | "auto" (auto = follow OS). */
  theme?: 'light' | 'dark' | 'auto'
  /** Maximum total bytes the in-memory undo history is allowed to use. */
  historyMemoryBytes: number
  /**
   * Soft cap (bytes) on total tracked buffer + texture memory across the
   * whole app (all open documents combined). Allocations that would push
   * the running total past this limit are rejected and surfaced to the
   * user as an error. Ignored when `bufferMemoryMaxOut` is true.
   */
  bufferMemoryBytes: number
  /**
   * If true, the buffer-memory cap is disabled — the app allocates until
   * the OS itself fails the request.
   */
  bufferMemoryMaxOut: boolean
  /**
   * Whether the host machine has unified memory (integrated/Apple-Silicon
   * GPU shares physical RAM with the CPU). When true, GPU texture
   * allocations count against the same `bufferMemoryBytes` cap as CPU
   * buffer allocations. When false (discrete VRAM), the cap applies to
   * CPU buffers only. Auto-defaulted from `process.platform` on first
   * launch by the renderer; persisted thereafter.
   */
  unifiedMemory?: boolean

  // ── Colour management (Tier 2c) ─────────────────────────────────────────
  /** Default rendering intent applied when converting an imported image's
   *  embedded profile into the document's working space. */
  colorImportIntent?: 'perceptual' | 'relative-colorimetric' | 'saturation' | 'absolute-colorimetric'
  /** Default rendering intent for the Convert to Profile command. */
  colorConvertIntent?: 'perceptual' | 'relative-colorimetric' | 'saturation' | 'absolute-colorimetric'
  /** Global Black Point Compensation toggle for ICC transforms. */
  colorUseBpc?: boolean
  /** Policy for untagged images on import. */
  colorMissingProfilePolicy?: 'assume-working-space' | 'ask'
}

const DEFAULT_PREFERENCES: AppPreferences = {
  theme: 'dark',
  // 4 GB default — generous on modern machines, tight enough that the
  // eviction path runs in normal use on multi-GB-per-layer documents.
  historyMemoryBytes: 4 * 1024 * 1024 * 1024,
  // 8 GB default for total tracked buffer memory — leaves headroom for the
  // history cap (4 GB) plus active layer data on a typical 16 GB machine.
  bufferMemoryBytes: 8 * 1024 * 1024 * 1024,
  bufferMemoryMaxOut: false,
  // Intentionally undefined here so the renderer's first-load path can
  // seed it from `process.platform`. Once the user has saved prefs at
  // least once, the persisted value wins.
  // Colour-management defaults match Photoshop conventions.
  colorImportIntent: 'perceptual',
  colorConvertIntent: 'relative-colorimetric',
  colorUseBpc: true,
  colorMissingProfilePolicy: 'assume-working-space',
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

  // Lets the renderer cap the buffer-memory slider at the actual system RAM
  // size so the user can't pick a value that's physically impossible.
  ipcMain.handle('system:totalMemoryBytes', (): number => totalmem())
}
