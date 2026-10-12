import { afterEach, describe, expect, it, vi } from "vitest";
import { cellPlaybackStore } from "@/core/store/cellPlaybackStore";

afterEach(() => {
  cellPlaybackStore.update({ playing: false, showing: false, index: 0 });
});

describe("cellPlaybackStore", () => {
  it("starts stopped on frame 0", () => {
    expect(cellPlaybackStore.snapshot).toEqual({ playing: false, showing: false, index: 0 });
  });

  it("update merges a patch into a new snapshot and notifies", () => {
    const fn = vi.fn();
    const off = cellPlaybackStore.subscribe(fn);
    const before = cellPlaybackStore.snapshot;
    cellPlaybackStore.update({ playing: true, showing: true });
    cellPlaybackStore.update({ index: 3 });
    expect(cellPlaybackStore.snapshot).toEqual({ playing: true, showing: true, index: 3 });
    expect(cellPlaybackStore.snapshot).not.toBe(before);
    expect(before).toEqual({ playing: false, showing: false, index: 0 });
    expect(fn).toHaveBeenCalledTimes(2);
    off();
  });

  it("a no-op update keeps the snapshot identity and doesn't notify", () => {
    cellPlaybackStore.update({ index: 2 });
    const snap = cellPlaybackStore.snapshot;
    const fn = vi.fn();
    const off = cellPlaybackStore.subscribe(fn);
    cellPlaybackStore.update({ index: 2 });
    cellPlaybackStore.update({});
    expect(cellPlaybackStore.snapshot).toBe(snap);
    expect(fn).not.toHaveBeenCalled();
    off();
  });
});
