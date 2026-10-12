import { app, ipcMain } from 'electron'
import { totalmem } from 'node:os'
import { copyFile, readFile } from 'node:fs/promises'
import { writeFileAtomic } from './atomicWrite'
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

const RENDERING_INTENTS = [
  'perceptual',
  'relative-colorimetric',
  'saturation',
  'absolute-colorimetric',
] as const

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === 'string' && (values as readonly string[]).includes(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isPositiveNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0

/** Validator per known field. The interface above is the whole schema:
 *  fields not listed here are dropped. */
const FIELD_VALIDATORS: { [K in keyof AppPreferences]-?: (v: unknown) => boolean } = {
  theme: oneOf(['light', 'dark', 'auto'] as const),
  historyMemoryBytes: isPositiveNumber,
  bufferMemoryBytes: isPositiveNumber,
  bufferMemoryMaxOut: isBool,
  unifiedMemory: isBool,
  colorImportIntent: oneOf(RENDERING_INTENTS),
  colorConvertIntent: oneOf(RENDERING_INTENTS),
  colorUseBpc: isBool,
  colorMissingProfilePolicy: oneOf(['assume-working-space', 'ask'] as const),
}

/** The defaults overlaid with every known field of `input` that has a valid
 *  value. Wrong-typed or out-of-range fields fall back to the default (or
 *  stay unset when there is none, e.g. `unifiedMemory`); unknown fields and
 *  non-object input are ignored. */
function sanitizePreferences(input: unknown): AppPreferences {
  const out: AppPreferences = { ...DEFAULT_PREFERENCES }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return out
  const src = input as Record<string, unknown>
  for (const key of Object.keys(FIELD_VALIDATORS) as Array<keyof AppPreferences>) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    const value = src[key]
    if (FIELD_VALIDATORS[key](value)) (out as unknown as Record<string, unknown>)[key] = value
  }
  return out
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

export function registerPreferencesHandlers(): void {
  ipcMain.handle('prefs:load', async (): Promise<AppPreferences> => {
    let raw: string
    try {
      raw = await readFile(prefsPath(), 'utf-8')
    } catch {
      // First run — no preferences file yet.
      return { ...DEFAULT_PREFERENCES }
    }
    try {
      return sanitizePreferences(JSON.parse(raw))
    } catch (err) {
      // Unreadable file: keep a copy instead of silently overwriting the
      // user's settings with defaults on the next save.
      const backup = `${prefsPath()}.corrupt-${Date.now()}`
      console.error(`[prefs] ${prefsPath()} is not valid JSON; kept a copy at ${backup}`, err)
      await copyFile(prefsPath(), backup).catch(() => undefined)
      return { ...DEFAULT_PREFERENCES }
    }
  })

  ipcMain.handle('prefs:save', async (_event, prefs: unknown): Promise<void> => {
    const sanitized = sanitizePreferences(prefs)
    await writeFileAtomic(prefsPath(), JSON.stringify(sanitized, null, 2), 'utf-8')
  })

  // Lets the renderer cap the buffer-memory slider at the actual system RAM
  // size so the user can't pick a value that's physically impossible.
  ipcMain.handle('system:totalMemoryBytes', (): number => totalmem())
}
