import type { LayerState, RGBAColor } from '@/types'

// ─── History entry ────────────────────────────────────────────────────────────

export interface HistoryEntry {
  id: string
  label: string
  timestamp: number
  /** Raw pixel data snapshot per layer, keyed by layer ID. Uint8Array for rgba8/indexed8, Float32Array for rgba32f. */
  layerPixels: Map<string, Uint8Array | Float32Array>
  /** Per-layer dimensions and canvas-space offset at the time of the snapshot. */
  layerGeometry: Map<string, { layerWidth: number; layerHeight: number; offsetX: number; offsetY: number }>
  /** Baked adjustment mask pixels keyed by adjustment layer ID. */
  adjustmentMasks: Map<string, Uint8Array>
  layerState: LayerState[]
  activeLayerId: string | null
  canvasWidth: number
  canvasHeight: number
  /** Swatch collection at the time of this snapshot. Optional so old entries are backward-compatible. */
  swatches?: RGBAColor[]
}

export interface ClearHistoryOptions {
  recaptureSnapshot?: boolean
}

function cloneLayerPixels(layerPixels: Map<string, Uint8Array | Float32Array>): Map<string, Uint8Array | Float32Array> {
  const cloned = new Map<string, Uint8Array | Float32Array>()
  for (const [layerId, pixels] of layerPixels) {
    cloned.set(layerId, (pixels as unknown) instanceof Float32Array
      ? new Float32Array(pixels as Float32Array)
      : new Uint8Array(pixels as Uint8Array))
  }
  return cloned
}

function cloneLayerGeometry(layerGeometry: Map<string, { layerWidth: number; layerHeight: number; offsetX: number; offsetY: number }>): Map<string, { layerWidth: number; layerHeight: number; offsetX: number; offsetY: number }> {
  const cloned = new Map<string, { layerWidth: number; layerHeight: number; offsetX: number; offsetY: number }>()
  for (const [layerId, geometry] of layerGeometry) cloned.set(layerId, { ...geometry })
  return cloned
}

function cloneAdjustmentMasks(adjustmentMasks: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const cloned = new Map<string, Uint8Array>()
  for (const [layerId, maskPixels] of adjustmentMasks) cloned.set(layerId, new Uint8Array(maskPixels))
  return cloned
}

export function cloneHistoryEntry(entry: HistoryEntry): HistoryEntry {
  return {
    ...entry,
    layerPixels: cloneLayerPixels(entry.layerPixels),
    layerGeometry: cloneLayerGeometry(entry.layerGeometry),
    adjustmentMasks: cloneAdjustmentMasks(entry.adjustmentMasks),
    layerState: structuredClone(entry.layerState),
    swatches: entry.swatches ? [...entry.swatches] : undefined,
  }
}

export function cloneHistoryEntries(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.map(cloneHistoryEntry)
}

// ─── Store ────────────────────────────────────────────────────────────────────

const MAX_HISTORY_ENTRIES = 50

class HistoryStore {
  entries: HistoryEntry[] = []
  currentIndex = -1
  selectedIndex = -1
  private listeners = new Set<() => void>()

  /**
   * Registered by App.tsx. Called when the user clicks Restore.
   * Must perform the actual canvas pixel + app state restoration.
   */
  onJumpTo: ((index: number) => void) | null = null

  /**
   * Registered by App.tsx. Called on every click to preview a history entry
   * on the canvas without committing state.
   */
  onPreview: ((index: number) => void) | null = null

  /**
   * Registered by useHistory. Called after clearing — allows a fresh snapshot
   * to be pushed so the cleared state is still recoverable via undo.
   */
  onClear: ((options?: ClearHistoryOptions) => void) | null = null

  private releaseEntry(e: HistoryEntry): void {
    e.layerPixels.clear()
    e.layerGeometry.clear()
    e.adjustmentMasks.clear()
  }

  push(entry: HistoryEntry): void {
    // Discard the redo chain (entries after currentIndex), releasing their buffers
    const redo = this.entries.splice(this.currentIndex + 1)
    redo.forEach(e => this.releaseEntry(e))

    this.entries.push(entry)

    // Cap history depth — release the oldest entry's buffers immediately
    if (this.entries.length > MAX_HISTORY_ENTRIES) {
      const oldest = this.entries.shift()!
      this.releaseEntry(oldest)
    }

    this.currentIndex = this.entries.length - 1
    this.selectedIndex = this.currentIndex
    this.notify()
  }

  /** Select an entry visually and preview it on the canvas. */
  select(index: number): void {
    if (index < 0 || index >= this.entries.length) return
    this.selectedIndex = index
    this.notify()
    this.onPreview?.(index)
  }

  /** Apply the selected entry, truncating all future entries. */
  jumpTo(index: number): void {
    if (index < 0 || index >= this.entries.length) return
    if (index === this.currentIndex) return
    this.onJumpTo?.(index)
  }

  undo(): void {
    if (this.currentIndex <= 0) return
    this.onJumpTo?.(this.currentIndex - 1)
  }

  redo(): void {
    if (this.currentIndex >= this.entries.length - 1) return
    this.onJumpTo?.(this.currentIndex + 1)
  }

  canUndo(): boolean { return this.currentIndex > 0 }
  canRedo(): boolean { return this.currentIndex < this.entries.length - 1 }

  /** Called by App.tsx after applying an entry — updates cursor, does NOT truncate. */
  setCurrent(index: number): void {
    this.currentIndex = index
    this.selectedIndex = index
    this.notify()
  }

  clear(options?: ClearHistoryOptions): void {
    this.entries.forEach(e => this.releaseEntry(e))
    this.entries = []
    this.currentIndex = -1
    this.selectedIndex = -1
    this.notify()
    this.onClear?.(options)
  }

  /**
   * Bulk-restore a previously snapshotted history state (e.g. when switching tabs).
   * Does NOT invoke onJumpTo/onPreview — the caller is responsible for
   * restoring canvas pixels separately.
   */
  restore(entries: HistoryEntry[], currentIndex: number): void {
    this.entries = entries
    this.currentIndex = currentIndex
    this.selectedIndex = currentIndex
    this.notify()
  }

  /**
   * Transfer ownership of the current entries out of the store in O(1).
   * Unlike cloneHistoryEntries, this performs NO allocation — the returned
   * object owns the arrays. The store is left empty after the call.
   * Use this when switching tabs so the caller can stash the history cheaply.
   */
  detach(): { entries: HistoryEntry[]; currentIndex: number } {
    const result = { entries: this.entries, currentIndex: this.currentIndex }
    this.entries = []
    this.currentIndex = -1
    this.selectedIndex = -1
    this.notify()
    return result
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb())
  }
}

export const historyStore = new HistoryStore()
