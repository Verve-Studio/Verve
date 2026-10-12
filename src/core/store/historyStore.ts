import type {
  LayerState,
  PixelFormat,
  RGBAColor,
  SpritesheetState,
  SwatchGroup,
} from "@/types";
import type { TiledLayerSnapshot } from "./tiledSnapshot";
import { DEFAULT_HISTORY_BYTES, validMemoryCapBytes } from "@/utils/memoryLimits";

// ─── History entry ────────────────────────────────────────────────────────────

export interface HistoryEntry {
  id: string;
  label: string;
  timestamp: number;
  /** Pixel snapshot per layer, keyed by layer ID, as immutable tiles shared
   *  with neighbouring entries wherever the layer didn't change (see
   *  tiledSnapshot.ts). Materialize with `materializeLayerPixels`. */
  layerPixels: Map<string, TiledLayerSnapshot>;
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
  /** Baked adjustment masks (canvas-sized rgba8) keyed by adjustment layer
   *  ID, tiled and shared like `layerPixels`. */
  adjustmentMasks: Map<string, TiledLayerSnapshot>;
  layerState: LayerState[];
  activeLayerId: string | null;
  canvasWidth: number;
  canvasHeight: number;
  /** Swatch collection at the time of this snapshot. Optional so old entries are backward-compatible. */
  swatches?: RGBAColor[];
  /** Swatch groups (they index into `swatches`, so they travel with it). */
  swatchGroups?: SwatchGroup[];
  /** Committed selection mask (canvas-sized, 1 byte per pixel, tiled and
   *  shared like `layerPixels`); null when nothing is selected. */
  selection?: TiledLayerSnapshot | null;
  /** Document ICC profile bytes at the time of this snapshot. `undefined`
   *  means the document was untagged. Optional for backward-compat with
   *  pre-CMS history entries. */
  iccProfile?: Uint8Array;
  /** Document-wide pixel format at the time of this snapshot. Optional for
   *  backward-compat with pre-format-history entries. */
  pixelFormat?: PixelFormat;
  /** Sprite-sheet grid and animations (document content; onion-skin and
   *  the selected animation / frame are view state and not recorded).
   *  Optional for entries that predate it. */
  spritesheet?: HistorySpritesheet;
}

export type HistorySpritesheet = Pick<
  SpritesheetState,
  "enabled" | "cellWidth" | "cellHeight" | "animations"
>;

/**
 * Value for `pendingLayerLabelRef` (useHistory) meaning "this layer change
 * is not an undo step yet": the operation records its own entry later (a new
 * text box is recorded when its editor commits) or leaves none (an abandoned
 * empty text box).
 */
export const SKIP_LAYER_HISTORY = "<skip-layer-history>";

export interface ClearHistoryOptions {
  recaptureSnapshot?: boolean;
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
let globalCapBytes = DEFAULT_HISTORY_BYTES;

/** Unique pixel buffers referenced by `entry` (with their sizes). */
function entryBuffers(entry: HistoryEntry): Map<ArrayBufferLike, number> {
  const out = new Map<ArrayBufferLike, number>();
  for (const snap of entrySnapshots(entry)) {
    for (const tile of snap.tiles) {
      if (!out.has(tile.buffer)) out.set(tile.buffer, tile.byteLength);
    }
  }
  return out;
}

/** Every tiled snapshot an entry holds (layers, adjustment masks, selection). */
function* entrySnapshots(entry: HistoryEntry): Iterable<TiledLayerSnapshot> {
  yield* entry.layerPixels.values();
  yield* entry.adjustmentMasks.values();
  if (entry.selection) yield entry.selection;
}

// App-level handlers registered once (by App.tsx / useHistory) and shared
// across every per-tab HistoryStore instance — see comment on the getters
// below for why these aren't per-instance fields.
const appHandlers: {
  onJumpTo: ((index: number) => void) | null;
  onClear: ((options?: ClearHistoryOptions) => void) | null;
  onBeforeNavigate: (() => void) | null;
} = {
  onJumpTo: null,
  onClear: null,
  onBeforeNavigate: null,
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
  /** Id of the first entry pushed since the store was created or cleared:
   *  the state "the baseline" refers to. Kept by id so evicting it (it is
   *  the oldest entry) can't make an edited document look clean. */
  private baselineEntryId: string | null = null;
  /** The baseline itself had unsaved changes (Clear History on a dirty
   *  document). */
  private baselineDirty = false;

  /** Record the current state as saved (called after a successful Save). */
  markSaved(): void {
    this.savedEntryId = this.entries[this.currentIndex]?.id ?? null;
    this.baselineDirty = false;
    this.notify();
  }

  /** Whether the document has changes that haven't been saved. */
  isDirty(): boolean {
    const current = this.entries[this.currentIndex];
    if (!current) return false;
    if (this.savedEntryId === null) {
      return current.id !== this.baselineEntryId || this.baselineDirty;
    }
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

  /**
   * Registered by useHistory: records edits whose capture is still deferred
   * (selection change, safety-net edit) before undo / redo / a jump reads
   * `currentIndex`. Otherwise undo would skip past them and lose them.
   */
  get onBeforeNavigate(): (() => void) | null {
    return appHandlers.onBeforeNavigate;
  }
  set onBeforeNavigate(fn: (() => void) | null) {
    appHandlers.onBeforeNavigate = fn;
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
    // A corrupt cap (0, negative, NaN) would evict every document's history.
    globalCapBytes = validMemoryCapBytes(bytes, DEFAULT_HISTORY_BYTES);
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
      for (const snap of entrySnapshots(e)) {
        for (const tile of snap.tiles) {
          const ab = tile.buffer;
          if (seen.has(ab)) continue;
          seen.add(ab);
          total += tile.byteLength;
        }
      }
    }
    return total;
  }

  private releaseEntry(e: HistoryEntry): void {
    e.layerPixels.clear();
    e.layerGeometry.clear();
    e.adjustmentMasks.clear();
    e.selection = null;
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
        // Never evict the entry the document is showing, only entries
        // before it (a store sitting at index 0 keeps everything).
        if (state.store.currentIndex <= 0) continue;
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
      store.currentIndex -= 1;
      store.selectedIndex = Math.max(0, store.selectedIndex - 1);
    }
  }

  push(entry: HistoryEntry): void {
    // Discard the redo chain (entries after currentIndex), releasing their buffers
    const redo = this.entries.splice(this.currentIndex + 1);
    redo.forEach((e) => this.releaseEntry(e));

    if (this.entries.length === 0) this.baselineEntryId = entry.id;
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

  /**
   * Click on a history entry: the document goes to that state (Photoshop
   * semantics); later entries stay available as redo until the next action
   * truncates them. A separate "preview" used to leave the document showing
   * one entry while undo, save and the next capture worked from another.
   */
  select(index: number): void {
    this.jumpTo(index);
  }

  /** Go to an entry; later entries remain as redo until the next push. */
  jumpTo(index: number): void {
    const target = this.entries[index];
    if (!target) return;
    this.onBeforeNavigate?.();
    // A flushed pending edit truncates the redo chain: the clicked entry may
    // be gone.
    if (this.entries[index] !== target) return;
    if (index === this.currentIndex) return;
    this.onJumpTo?.(index);
  }

  undo(): void {
    this.onBeforeNavigate?.();
    if (this.currentIndex <= 0) return;
    this.onJumpTo?.(this.currentIndex - 1);
  }

  redo(): void {
    this.onBeforeNavigate?.();
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
    // The state recorded next becomes the new baseline: clean exactly when
    // the document was clean before the clear.
    const wasDirty = this.isDirty();
    this.savedEntryId = null;
    this.baselineEntryId = null;
    this.baselineDirty = wasDirty;
    this.entries.forEach((e) => this.releaseEntry(e));
    this.entries = [];
    this.currentIndex = -1;
    this.selectedIndex = -1;
    this.notify();
    this.onClear?.(options);
  }

  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  notify(): void {
    listeners.forEach((cb) => cb());
  }
}
