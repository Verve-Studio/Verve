import { afterEach, describe, expect, it, vi } from "vitest";
import { CloneStampStore } from "@/core/store/cloneStampStore";

afterEach(() => {
  new CloneStampStore().onSourceDeleted = null;
});

describe("CloneStampStore", () => {
  it("setSource records the anchor and resets the aligned offset", () => {
    const c = new CloneStampStore();
    c.alignedOffset = { dx: 3, dy: 4 };
    const fn = vi.fn();
    c.subscribe(fn);
    c.setSource(10, 20, "layer-1");
    c.unsubscribe(fn);
    expect(c.source).toEqual({ x: 10, y: 20, layerId: "layer-1" });
    expect(c.alignedOffset).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("clearSource drops the source and fires the shared app handler", () => {
    const a = new CloneStampStore();
    const b = new CloneStampStore();
    const handler = vi.fn();
    a.onSourceDeleted = handler;
    b.setSource(1, 1, "l");
    b.alignedOffset = { dx: 1, dy: 1 };
    b.clearSource();
    expect(b.source).toBeNull();
    expect(b.alignedOffset).toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("instances hold their own source", () => {
    const a = new CloneStampStore();
    const b = new CloneStampStore();
    a.setSource(1, 2, "x");
    expect(b.source).toBeNull();
  });
});
