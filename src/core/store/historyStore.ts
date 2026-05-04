import type { LayerState, RGBAColor } from '@/types'

// ─── History entry ────────────────────────────────────────────────────────────

export interface HistoryEntry {
  id: string
  label: string
  timestamp: number
  /** Raw pixel data snapshot per layer, keyed by layer ID. Uint8Array for rgba8/indexed8, Float32Array for rgba32f. */
  layerPixels: Map<string, Uint8Array | Float32Array>
  /**
   * Per-layer contentVersion at the time of the snapshot. Used by
   * `useHistory.captureHistory` to share pixel buffer references across
   * entries when a layer hasn't changed — dramatically reduces per-entry
   * RAM (one paint stroke on a 10-layer doc clones 1 buffer, not 10).
   */
  layerContentVersions?: Map<string, number>
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
    layerContentVersions: entry.layerContentVersions ? new Map(entry.layerContentVersions) : undefined,
    swatches: entry.swatches ? [...entry.swatches] : undefined,
  }
}

export function cloneHistoryEntries(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.map(cloneHistoryEntry)
}

// ─── Store ────────────────────────────────────────────────────────────────────

class HistoryStore {
  entries: HistoryEntry[] = []
  currentIndex = -1
  selectedIndex = -1
  private listeners = new Set<() => void>()

  /**
   * Maximum total bytes allowed across all history entries (after dedup of
   * shared buffers). Set by `useHistory` from the user's `historyMemoryBytes`
   * preference. Defaults to 4 GB so the store works before the renderer
   * has loaded preferences.
   */
  private memoryCapBytes = 4 * 1024 * 1024 * 1024

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

  /**
   * Set the memory cap (in bytes) and immediately evict oldest entries until
   * the total fits. Called by `useHistory` whenever the preference changes.
   */
  setMemoryCapBytes(bytes: number): void {
    this.memoryCapBytes = Math.max(0, bytes)
    this.evictUntilUnderCap()
    this.notify()
  }

  getMemoryCapBytes(): number { return this.memoryCapBytes }

  /**
   * Total live RAM used by all entries, with shared buffer references counted
   * exactly once. Pixel buffers are deduplicated across entries (see
   * `useHistory.captureHistory`), so naive summing of `byteLength` per entry
   * would double-count.
   */
  getCurrentBytes(): number {
    const seen = new Set<ArrayBufferLike>()
    let total = 0
    for (const e of this.entries) {
      for (const buf of e.layerPixels.values()) {
        const ab = buf.buffer
        if (seen.has(ab)) continue
        seen.add(ab)
        total += buf.byteLength
      }
      for (const buf of e.adjustmentMasks.values()) {
        const ab = buf.buffer
        if (seen.has(ab)) continue
        seen.add(ab)
        total += buf.byteLength
      }
    }
    return total
  }

  private releaseEntry(e: HistoryEntry): void {
    e.layerPixels.clear()
    e.layerGeometry.clear()
    e.adjustmentMasks.clear()
    e.layerContentVersions?.clear()
  }

  /**
   * Drop oldest entries (and adjust currentIndex/selectedIndex) until the
   * deduplicated total is <= cap. Always keeps at least one entry so undo
   * always has a baseline. Caller is responsible for `notify()`.
   */
  private evictUntilUnderCap(): void {
    while (this.entries.length > 1 && this.getCurrentBytes() > this.memoryCapBytes) {
      const oldest = this.entries.shift()!
      this.releaseEntry(oldest)
      this.currentIndex = Math.max(0, this.currentIndex - 1)
      this.selectedIndex = Math.max(0, this.selectedIndex - 1)
    }
  }

  push(entry: HistoryEntry): void {
    // Discard the redo chain (entries after currentIndex), releasing their buffers
    const redo = this.entries.splice(this.currentIndex + 1)
    redo.forEach(e => this.releaseEntry(e))

    this.entries.push(entry)
    this.currentIndex = this.entries.length - 1
    this.selectedIndex = this.currentIndex

    // Memory cap: evict oldest entries until under the byte budget. Replaces
    // the old fixed entry-count cap — entry size varies wildly between docs
    // (a 7000×9933 layer is ~278 MB; a 512×512 layer is ~1 MB), so a count
    // cap is meaningless. Byte cap gives the user direct control over RAM.
    this.evictUntilUnderCap()

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
