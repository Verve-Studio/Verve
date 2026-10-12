import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryStore, type HistoryEntry } from "@/core/store/historyStore";
import { snapshotFull, type TiledLayerSnapshot } from "@/core/store/tiledSnapshot";

// Every HistoryStore registers itself in a module-level set that shares one
// memory budget. Dispose every store a test creates so they don't leak into
// the next test's accounting, and restore the default cap.
const created: HistoryStore[] = [];
const DEFAULT_CAP = 4 * 1024 * 1024 * 1024;

function newStore(): HistoryStore {
  const s = new HistoryStore();
  created.push(s);
  return s;
}

afterEach(() => {
  // The cap and the app handlers are module-level: reset them through a
  // throwaway instance.
  const s = newStore();
  s.setMemoryCapBytes(DEFAULT_CAP);
  s.onJumpTo = null;
  s.onClear = null;
  s.onBeforeNavigate = null;
  for (const c of created) c.dispose();
  created.length = 0;
});

let nextId = 0;
let clock = 1000;

/** A history entry holding one layer snapshot (`bytes` bytes, one tile). */
function entry(opts: {
  bytes?: number;
  layer?: TiledLayerSnapshot;
  timestamp?: number;
  label?: string;
} = {}): HistoryEntry {
  const layer =
    opts.layer ?? snapshotFull(new Uint8Array(opts.bytes ?? 64), (opts.bytes ?? 64) / 4, 1, 4);
  return {
    id: `e${nextId++}`,
    label: opts.label ?? "Edit",
    timestamp: opts.timestamp ?? clock++,
    layerPixels: new Map([["layer-0", layer]]),
    layerGeometry: new Map([
      ["layer-0", { layerWidth: layer.width, layerHeight: layer.height, offsetX: 0, offsetY: 0 }],
    ]),
    adjustmentMasks: new Map(),
    layerState: [],
    activeLayerId: "layer-0",
    canvasWidth: layer.width,
    canvasHeight: layer.height,
  };
}

/** Wire onJumpTo the way useHistory does: apply the entry, then setCurrent. */
function autoApply(store: HistoryStore): ReturnType<typeof vi.fn> {
  const jump = vi.fn((i: number) => store.setCurrent(i));
  store.onJumpTo = jump;
  return jump;
}

describe("HistoryStore cursor semantics", () => {
  it("push moves the cursor to the new entry", () => {
    const h = newStore();
    expect(h.currentIndex).toBe(-1);
    expect(h.canUndo()).toBe(false);
    h.push(entry());
    h.push(entry());
    expect(h.currentIndex).toBe(1);
    expect(h.selectedIndex).toBe(1);
    expect(h.canUndo()).toBe(true);
    expect(h.canRedo()).toBe(false);
  });

  it("undo / redo go through onJumpTo and stop at the ends", () => {
    const h = newStore();
    const jump = autoApply(h);
    h.push(entry());
    h.undo(); // at index 0 → nothing
    expect(jump).not.toHaveBeenCalled();
    h.push(entry());
    h.push(entry());
    h.undo();
    expect(jump).toHaveBeenLastCalledWith(1);
    h.undo();
    expect(h.currentIndex).toBe(0);
    h.undo();
    expect(jump).toHaveBeenCalledTimes(2);
    expect(h.canRedo()).toBe(true);
    h.redo();
    h.redo();
    expect(h.currentIndex).toBe(2);
    h.redo();
    expect(jump).toHaveBeenCalledTimes(4);
  });

  it("undo without a registered handler does not move the cursor", () => {
    const h = newStore();
    h.push(entry());
    h.push(entry());
    h.undo();
    expect(h.currentIndex).toBe(1);
  });

  it("push after undo truncates the redo chain and releases its entries", () => {
    const h = newStore();
    autoApply(h);
    h.push(entry());
    h.push(entry());
    const dropped = entry();
    h.push(dropped);
    h.undo();
    h.undo();
    expect(h.currentIndex).toBe(0);
    const fresh = entry();
    h.push(fresh);
    expect(h.entries.map((e) => e.id)).toEqual([h.entries[0].id, fresh.id]);
    expect(h.currentIndex).toBe(1);
    expect(h.canRedo()).toBe(false);
    expect(dropped.layerPixels.size).toBe(0);
    expect(dropped.layerGeometry.size).toBe(0);
  });

  it("setCurrent moves the cursor without truncating", () => {
    const h = newStore();
    h.push(entry());
    h.push(entry());
    h.push(entry());
    h.setCurrent(0);
    expect(h.entries).toHaveLength(3);
    expect(h.canRedo()).toBe(true);
    expect(h.selectedIndex).toBe(0);
  });

  it("jumpTo ignores out-of-range and current indices", () => {
    const h = newStore();
    const jump = autoApply(h);
    h.push(entry());
    h.push(entry());
    h.jumpTo(5);
    h.jumpTo(-1);
    h.jumpTo(1);
    expect(jump).not.toHaveBeenCalled();
    h.select(0);
    expect(jump).toHaveBeenCalledWith(0);
  });

  it("onBeforeNavigate runs before undo reads currentIndex", () => {
    const h = newStore();
    autoApply(h);
    h.push(entry());
    // A deferred edit is recorded by the navigate hook; undo must then step
    // back from it, not from the stale index.
    h.onBeforeNavigate = vi.fn(() => {
      h.onBeforeNavigate = null;
      h.push(entry({ label: "Deferred" }));
    });
    h.undo();
    expect(h.entries).toHaveLength(2);
    expect(h.currentIndex).toBe(0);
  });

  it("jumpTo bails when the navigate hook truncated the target away", () => {
    const h = newStore();
    const jump = autoApply(h);
    h.push(entry());
    h.push(entry());
    h.push(entry());
    h.setCurrent(0);
    h.onBeforeNavigate = () => {
      h.onBeforeNavigate = null;
      h.push(entry()); // truncates entries 1 and 2
    };
    h.jumpTo(2);
    expect(jump).not.toHaveBeenCalled();
  });

  it("app handlers are shared by every instance (survive scope switches)", () => {
    const a = newStore();
    const b = newStore();
    const fn = (): void => {};
    a.onJumpTo = fn;
    expect(b.onJumpTo).toBe(fn);
    b.onClear = fn;
    expect(a.onClear).toBe(fn);
  });

  it("notifies subscribers on push and stops after unsubscribe", () => {
    const h = newStore();
    const cb = vi.fn();
    const off = h.subscribe(cb);
    h.push(entry());
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    h.push(entry());
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("HistoryStore dirty tracking", () => {
  it("a new document is clean on its baseline and dirty after an edit", () => {
    const h = newStore();
    autoApply(h);
    expect(h.isDirty()).toBe(false);
    h.push(entry());
    expect(h.isDirty()).toBe(false);
    h.push(entry());
    expect(h.isDirty()).toBe(true);
    h.undo();
    expect(h.isDirty()).toBe(false);
  });

  it("markSaved makes the current entry the clean point", () => {
    const h = newStore();
    autoApply(h);
    h.push(entry());
    h.push(entry());
    h.markSaved();
    expect(h.isDirty()).toBe(false);
    h.undo();
    expect(h.isDirty()).toBe(true);
    h.redo();
    expect(h.isDirty()).toBe(false);
  });

  it("a saved entry truncated away keeps the document dirty", () => {
    const h = newStore();
    autoApply(h);
    h.push(entry());
    h.push(entry());
    h.markSaved();
    h.undo();
    h.push(entry());
    expect(h.isDirty()).toBe(true);
  });

  it("clear on a clean document keeps the next baseline clean", () => {
    const h = newStore();
    const onClear = vi.fn();
    h.onClear = onClear;
    h.push(entry());
    h.clear({ recaptureSnapshot: true });
    expect(onClear).toHaveBeenCalledWith({ recaptureSnapshot: true });
    expect(h.entries).toHaveLength(0);
    expect(h.currentIndex).toBe(-1);
    h.push(entry());
    expect(h.isDirty()).toBe(false);
  });

  it("clear on a dirty document keeps the new baseline dirty until saved", () => {
    const h = newStore();
    h.push(entry());
    h.push(entry());
    expect(h.isDirty()).toBe(true);
    h.clear();
    h.push(entry());
    expect(h.isDirty()).toBe(true);
    h.markSaved();
    expect(h.isDirty()).toBe(false);
  });

  it("evicting the baseline entry does not make an edited document clean", () => {
    const h = newStore();
    h.push(entry({ bytes: 64 }));
    h.push(entry({ bytes: 64 }));
    h.push(entry({ bytes: 64 }));
    h.setMemoryCapBytes(128);
    expect(h.entries).toHaveLength(2);
    expect(h.isDirty()).toBe(true);
  });
});

describe("HistoryStore memory accounting and cap", () => {
  it("counts shared tile buffers once", () => {
    const h = newStore();
    const layer = snapshotFull(new Uint8Array(256), 64, 1, 4);
    h.push(entry({ layer }));
    h.push(entry({ layer }));
    expect(h.getCurrentBytes()).toBe(256);
    h.push(entry({ bytes: 128 }));
    expect(h.getCurrentBytes()).toBe(384);
  });

  it("counts adjustment masks and the selection snapshot", () => {
    const h = newStore();
    const e = entry({ bytes: 64 });
    e.adjustmentMasks.set("adj", snapshotFull(new Uint8Array(32), 8, 1, 4));
    e.selection = snapshotFull(new Uint8Array(10), 10, 1, 1);
    h.push(e);
    expect(h.getCurrentBytes()).toBe(64 + 32 + 10);
  });

  it("evicts oldest entries until the total fits, keeping the current one", () => {
    const h = newStore();
    h.setMemoryCapBytes(200);
    for (let i = 0; i < 5; i++) h.push(entry({ bytes: 64 }));
    expect(h.getCurrentBytes()).toBeLessThanOrEqual(200);
    expect(h.entries).toHaveLength(3);
    expect(h.currentIndex).toBe(2);
    expect(h.selectedIndex).toBe(2);
  });

  it("never evicts the entry on screen even when it alone exceeds the cap", () => {
    const h = newStore();
    h.setMemoryCapBytes(10);
    h.push(entry({ bytes: 64 }));
    h.push(entry({ bytes: 64 }));
    expect(h.entries).toHaveLength(1);
    expect(h.currentIndex).toBe(0);
  });

  it("keeps redo entries after the cursor when sitting at index 0", () => {
    const h = newStore();
    h.push(entry({ bytes: 64 }));
    h.push(entry({ bytes: 64 }));
    h.push(entry({ bytes: 64 }));
    h.setCurrent(0);
    h.setMemoryCapBytes(64);
    expect(h.entries).toHaveLength(3);
  });

  it("evicting an entry that shares tiles frees only unshared bytes", () => {
    const h = newStore();
    const shared = snapshotFull(new Uint8Array(100), 25, 1, 4);
    h.push(entry({ layer: shared }));
    h.push(entry({ layer: shared }));
    h.push(entry({ bytes: 40 }));
    // Total 140. Cap 140 → nothing evicted; cap 139 → evicting entry 0 frees
    // nothing (entry 1 still holds the buffer), so entry 1 goes as well.
    h.setMemoryCapBytes(140);
    expect(h.entries).toHaveLength(3);
    h.setMemoryCapBytes(139);
    expect(h.entries).toHaveLength(1);
    expect(h.getCurrentBytes()).toBe(40);
  });

  it("the cap is one budget across all documents; oldest entries go first", () => {
    const a = newStore();
    const b = newStore();
    a.push(entry({ bytes: 64, timestamp: 1 }));
    b.push(entry({ bytes: 64, timestamp: 2 }));
    a.push(entry({ bytes: 64, timestamp: 3 }));
    b.push(entry({ bytes: 64, timestamp: 4 }));
    expect(HistoryStore.totalBytes()).toBe(256);
    a.setMemoryCapBytes(192);
    // a's first entry (t=1) is globally oldest.
    expect(a.entries.map((e) => e.timestamp)).toEqual([3]);
    expect(b.entries.map((e) => e.timestamp)).toEqual([2, 4]);
    expect(b.getMemoryCapBytes()).toBe(192);
    b.setMemoryCapBytes(128);
    expect(b.entries.map((e) => e.timestamp)).toEqual([4]);
    expect(HistoryStore.totalBytes()).toBe(128);
  });

  it("a disposed store stops counting toward the shared budget", () => {
    const a = newStore();
    const b = newStore();
    a.push(entry({ bytes: 64 }));
    b.push(entry({ bytes: 64 }));
    expect(HistoryStore.totalBytes()).toBe(128);
    const listener = vi.fn();
    b.subscribe(listener);
    const onClear = vi.fn();
    b.onClear = onClear;
    b.dispose();
    expect(HistoryStore.totalBytes()).toBe(64);
    expect(b.entries).toHaveLength(0);
    expect(b.currentIndex).toBe(-1);
    // dispose is silent: no notify, no onClear routed to the active tab.
    expect(listener).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  it("corrupt caps (0, negative, NaN) fall back to the default instead of evicting everything", () => {
    const h = newStore();
    for (const bad of [-5, 0, NaN, Infinity]) {
      h.setMemoryCapBytes(DEFAULT_CAP);
      h.setMemoryCapBytes(bad);
      expect(h.getMemoryCapBytes()).toBe(4 * 1024 ** 3);
    }
  });
});
