import type { LayerState, PixelFormat, RGBAColor } from "@/types";

// ─── History entry ────────────────────────────────────────────────────────────

export interface HistoryEntry {
  id: string;
  label: string;
  timestamp: number;
  /** Raw pixel data snapshot per layer, keyed by layer ID. Uint8Array for rgba8/indexed8, Float32Array for rgba32f. */
  layerPixels: Map<string, Uint8Array | Float32Array>;
  /**
   * Per-layer contentVersion at the time of the snapshot. Used by
   * `useHistory.captureHistory` to share pixel buffer references across
   * entries when a layer hasn't changed — dramatically reduces per-entry
   * RAM (one paint stroke on a 10-layer doc clones 1 buffer, not 10).
   */
  layerContentVersions?: Map<string, number>;
  /** Per-layer dimensions and canvas-space offset at the time of the snapshot. */
  layerGeometry: Map<
    string,
    {
      layerWidth: number;
      layerHeight: number;
      offsetX: number;
      offsetY: number;
    }
  >;
  /** Baked adjustment mask pixels keyed by adjustment layer ID. */
  adjustmentMasks: Map<string, Uint8Array>;
  layerState: LayerState[];
  activeLayerId: string | null;
  canvasWidth: number;
  canvasHeight: number;
  /** Swatch collection at the time of this snapshot. Optional so old entries are backward-compatible. */
  swatches?: RGBAColor[];
  /** Document ICC profile bytes at the time of this snapshot. `undefined`
   *  means the document was untagged. Optional for backward-compat with
   *  pre-CMS history entries. */
  iccProfile?: Uint8Array;
  /** Document-wide pixel format at the time of this snapshot. Optional for
   *  backward-compat with pre-format-history entries. */
  pixelFormat?: PixelFormat;
}

export interface ClearHistoryOptions {
  recaptureSnapshot?: boolean;
}

function cloneLayerPixels(
  layerPixels: Map<string, Uint8Array | Float32Array>,
): Map<string, Uint8Array | Float32Array> {
  const cloned = new Map<string, Uint8Array | Float32Array>();
  for (const [layerId, pixels] of layerPixels) {
    cloned.set(
      layerId,
      (pixels as unknown) instanceof Float32Array
        ? new Float32Array(pixels as Float32Array)
        : new Uint8Array(pixels as Uint8Array),
    );
  }
  return cloned;
}

function cloneLayerGeometry(
  layerGeometry: Map<
    string,
    {
      layerWidth: number;
      layerHeight: number;
      offsetX: number;
      offsetY: number;
    }
  >,
): Map<
  string,
  { layerWidth: number; layerHeight: number; offsetX: number; offsetY: number }
> {
  const cloned = new Map<
    string,
    {
      layerWidth: number;
      layerHeight: number;
      offsetX: number;
      offsetY: number;
    }
  >();
  for (const [layerId, geometry] of layerGeometry)
    cloned.set(layerId, { ...geometry });
  return cloned;
}

function cloneAdjustmentMasks(
  adjustmentMasks: Map<string, Uint8Array>,
): Map<string, Uint8Array> {
  const cloned = new Map<string, Uint8Array>();
  for (const [layerId, maskPixels] of adjustmentMasks)
    cloned.set(layerId, new Uint8Array(maskPixels));
  return cloned;
}

export function cloneHistoryEntry(entry: HistoryEntry): HistoryEntry {
  return {
    ...entry,
    layerPixels: cloneLayerPixels(entry.layerPixels),
    layerGeometry: cloneLayerGeometry(entry.layerGeometry),
    adjustmentMasks: cloneAdjustmentMasks(entry.adjustmentMasks),
    layerState: structuredClone(entry.layerState),
    layerContentVersions: entry.layerContentVersions
      ? new Map(entry.layerContentVersions)
      : undefined,
    swatches: entry.swatches ? [...entry.swatches] : undefined,
    iccProfile: entry.iccProfile ? new Uint8Array(entry.iccProfile) : undefined,
    pixelFormat: entry.pixelFormat,
  };
}

export function cloneHistoryEntries(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.map(cloneHistoryEntry);
}

// ─── Store ────────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();

/**
 * Every live HistoryStore (one per open document). The memory cap is one
 * budget across all of them: a per-tab cap let N open documents hold N× the
 * RAM the user allowed, and scopes created after startup never even
 * received the user's preference (they kept the 4 GB default).
 */
const liveStores = new Set<HistoryStore>();
let globalCapBytes = 4 * 1024 * 1024 * 1024;

/** Unique pixel buffers referenced by `entry` (with their sizes). */
function entryBuffers(entry: HistoryEntry): Map<ArrayBufferLike, number> {
  const out = new Map<ArrayBufferLike, number>();
  for (const buf of entry.layerPixels.values()) {
    if (!out.has(buf.buffer)) out.set(buf.buffer, buf.byteLength);
  }
  for (const buf of entry.adjustmentMasks.values()) {
    if (!out.has(buf.buffer)) out.set(buf.buffer, buf.byteLength);
  }
  return out;
}

// App-level handlers registered once (by App.tsx / useHistory) and shared
// across every per-tab HistoryStore instance — see comment on the getters
// below for why these aren't per-instance fields.
const appHandlers: {
  onJumpTo: ((index: number) => void) | null;
  onPreview: ((index: number) => void) | null;
  onClear: ((options?: ClearHistoryOptions) => void) | null;
} = {
  onJumpTo: null,
  onPreview: null,
  onClear: null,
};

export class HistoryStore {
  entries: HistoryEntry[] = [];
  currentIndex = -1;
  selectedIndex = -1;

  constructor() {
    liveStores.add(this);
  }

  /**
   * Id of the entry the document matched when it was last saved. `null`
   * means "the baseline": a freshly opened or created document is clean
   * while it sits on its first history entry.
   */
  private savedEntryId: string | null = null;

  /** Record the current state as saved (called after a successful Save). */
  markSaved(): void {
    this.savedEntryId = this.entries[this.currentIndex]?.id ?? null;
    this.notify();
  }

  /** Whether the document has changes that haven't been saved. */
  isDirty(): boolean {
    const current = this.entries[this.currentIndex];
    if (!current) return false;
    if (this.savedEntryId === null) return this.currentIndex > 0;
    return current.id !== this.savedEntryId;
  }

  /**
   * Registered by App.tsx. Called when the user clicks Restore.
   * Must perform the actual canvas pixel + app state restoration.
   *
   * These app-level handlers are kept module-level (not on the instance)
   * so that registering them once survives `setActiveScope()` swapping the
   * active scope to a different tab's history instance — there is only ever
   * one active history at a time.
   */
  get onJumpTo(): ((index: number) => void) | null {
    return appHandlers.onJumpTo;
  }
  set onJumpTo(fn: ((index: number) => void) | null) {
    appHandlers.onJumpTo = fn;
  }

  get onPreview(): ((index: number) => void) | null {
    return appHandlers.onPreview;
  }
  set onPreview(fn: ((index: number) => void) | null) {
    appHandlers.onPreview = fn;
  }

  get onClear(): ((options?: ClearHistoryOptions) => void) | null {
    return appHandlers.onClear;
  }
  set onClear(fn: ((options?: ClearHistoryOptions) => void) | null) {
    appHandlers.onClear = fn;
  }

  /**
   * Set the memory cap (in bytes) shared by every document's history and
   * immediately evict oldest entries until the total fits. Called by
   * `useHistory` whenever the preference changes.
   */
  setMemoryCapBytes(bytes: number): void {
    globalCapBytes = Math.max(0, bytes);
    HistoryStore.enforceMemoryCap();
    this.notify();
  }

  getMemoryCapBytes(): number {
    return globalCapBytes;
  }

  /** Bytes used by the history of every open document together. */
  static totalBytes(): number {
    let total = 0;
    for (const store of liveStores) total += store.getCurrentBytes();
    return total;
  }

  /**
   * Total live RAM used by all entries, with shared buffer references counted
   * exactly once. Pixel buffers are deduplicated across entries (see
   * `useHistory.captureHistory`), so naive summing of `byteLength` per entry
   * would double-count.
   */
  getCurrentBytes(): number {
    const seen = new Set<ArrayBufferLike>();
    let total = 0;
    for (const e of this.entries) {
      for (const buf of e.layerPixels.values()) {
        const ab = buf.buffer;
        if (seen.has(ab)) continue;
        seen.add(ab);
        total += buf.byteLength;
      }
      for (const buf of e.adjustmentMasks.values()) {
        const ab = buf.buffer;
        if (seen.has(ab)) continue;
        seen.add(ab);
        total += buf.byteLength;
      }
    }
    return total;
  }

  private releaseEntry(e: HistoryEntry): void {
    e.layerPixels.clear();
    e.layerGeometry.clear();
    e.adjustmentMasks.clear();
    e.layerContentVersions?.clear();
  }

  /**
   * Drop oldest entries (and adjust currentIndex/selectedIndex) until the
   * deduplicated total is <= cap. Always keeps at least one entry so undo
   * always has a baseline. Caller is responsible for `notify()`.
   */
  /**
   * Evict the globally oldest history entries (by timestamp, across every
   * open document) until the total fits the shared cap. Each store keeps at
   * least one entry so undo always has a baseline. Background tabs' older
   * entries therefore go first.
   *
   * Freed bytes are tracked with per-store buffer reference counts built
   * once up front, instead of recomputing every store's deduplicated total
   * after each eviction (which was O(entries² × layers)).
   */
  private static enforceMemoryCap(): void {
    const states = [...liveStores].map((store) => {
      const refs = new Map<ArrayBufferLike, { count: number; bytes: number }>();
      for (const entry of store.entries) {
        for (const [buf, bytes] of entryBuffers(entry)) {
          const r = refs.get(buf);
          if (r) r.count++;
          else refs.set(buf, { count: 1, bytes });
        }
      }
      return { store, refs };
    });
    let total = 0;
    for (const { refs } of states) {
      for (const r of refs.values()) total += r.bytes;
    }
    while (total > globalCapBytes) {
      let victim: (typeof states)[number] | null = null;
      for (const state of states) {
        if (state.store.entries.length <= 1) continue;
        if (
          !victim ||
          state.store.entries[0].timestamp < victim.store.entries[0].timestamp
        ) {
          victim = state;
        }
      }
      if (!victim) break;
      const { store, refs } = victim;
      const oldest = store.entries.shift()!;
      for (const buf of entryBuffers(oldest).keys()) {
        const r = refs.get(buf)!;
        if (--r.count === 0) {
          total -= r.bytes;
          refs.delete(buf);
        }
      }
      store.releaseEntry(oldest);
      store.currentIndex = Math.max(0, store.currentIndex - 1);
      store.selectedIndex = Math.max(0, store.selectedIndex - 1);
    }
  }

  push(entry: HistoryEntry): void {
    // Discard the redo chain (entries after currentIndex), releasing their buffers
    const redo = this.entries.splice(this.currentIndex + 1);
    redo.forEach((e) => this.releaseEntry(e));

    this.entries.push(entry);
    this.currentIndex = this.entries.length - 1;
    this.selectedIndex = this.currentIndex;

    // Memory cap: evict oldest entries until under the byte budget. Replaces
    // the old fixed entry-count cap — entry size varies wildly between docs
    // (a 7000×9933 layer is ~278 MB; a 512×512 layer is ~1 MB), so a count
    // cap is meaningless. Byte cap gives the user direct control over RAM.
    HistoryStore.enforceMemoryCap();

    this.notify();
  }

  /** Select an entry visually and preview it on the canvas. */
  select(index: number): void {
    if (index < 0 || index >= this.entries.length) return;
    this.selectedIndex = index;
    this.notify();
    this.onPreview?.(index);
  }

  /** Apply the selected entry, truncating all future entries. */
  jumpTo(index: number): void {
    if (index < 0 || index >= this.entries.length) return;
    if (index === this.currentIndex) return;
    this.onJumpTo?.(index);
  }

  undo(): void {
    if (this.currentIndex <= 0) return;
    this.onJumpTo?.(this.currentIndex - 1);
  }

  redo(): void {
    if (this.currentIndex >= this.entries.length - 1) return;
    this.onJumpTo?.(this.currentIndex + 1);
  }

  canUndo(): boolean {
    return this.currentIndex > 0;
  }
  canRedo(): boolean {
    return this.currentIndex < this.entries.length - 1;
  }

  /** Called by App.tsx after applying an entry — updates cursor, does NOT truncate. */
  setCurrent(index: number): void {
    this.currentIndex = index;
    this.selectedIndex = index;
    this.notify();
  }

  /**
   * Release every entry without notifying subscribers or firing `onClear`.
   * For a scope that is being thrown away (closed tab) — `clear()` would
   * route `onClear` to the *active* tab's handler and record a
   * "History Cleared" entry there.
   */
  dispose(): void {
    this.entries.forEach((e) => this.releaseEntry(e));
    this.entries = [];
    this.currentIndex = -1;
    this.selectedIndex = -1;
    liveStores.delete(this);
  }

  clear(options?: ClearHistoryOptions): void {
    this.entries.forEach((e) => this.releaseEntry(e));
    this.entries = [];
    this.currentIndex = -1;
    this.selectedIndex = -1;
    this.notify();
    this.onClear?.(options);
  }

  /**
   * Bulk-restore a previously snapshotted history state (e.g. when switching tabs).
   * Does NOT invoke onJumpTo/onPreview — the caller is responsible for
   * restoring canvas pixels separately.
   */
  restore(entries: HistoryEntry[], currentIndex: number): void {
    this.entries = entries;
    this.currentIndex = currentIndex;
    this.selectedIndex = currentIndex;
    this.notify();
  }

  /**
   * Transfer ownership of the current entries out of the store in O(1).
   * Unlike cloneHistoryEntries, this performs NO allocation — the returned
   * object owns the arrays. The store is left empty after the call.
   * Use this when switching tabs so the caller can stash the history cheaply.
   */
  detach(): { entries: HistoryEntry[]; currentIndex: number } {
    const result = { entries: this.entries, currentIndex: this.currentIndex };
    this.entries = [];
    this.currentIndex = -1;
    this.selectedIndex = -1;
    this.notify();
    return result;
  }

  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  notify(): void {
    listeners.forEach((cb) => cb());
  }
}
