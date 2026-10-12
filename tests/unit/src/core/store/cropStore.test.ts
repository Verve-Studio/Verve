import { afterEach, describe, expect, it, vi } from "vitest";
import { CropStore } from "@/core/store/cropStore";

afterEach(() => {
  new CropStore().onCrop = null;
});

describe("CropStore", () => {
  it("commitRect normalises a drag in any direction and rounds", () => {
    const c = new CropStore();
    c.commitRect(10.4, 20.6, 2.2, 5);
    expect(c.rect).toEqual({ x: 2, y: 5, w: 8, h: 16 });
    expect(c.pendingRect).toBeNull();
  });

  it("a zero-area commit leaves no rect", () => {
    const c = new CropStore();
    c.commitRect(5, 5, 5, 30);
    expect(c.rect).toBeNull();
    c.commitRect(1, 1, 1.2, 1.2);
    expect(c.rect).toBeNull();
  });

  it("setPending replaces any committed rect; clear drops both", () => {
    const c = new CropStore();
    c.commitRect(0, 0, 4, 4);
    c.setPending(1, 2, 3, 4);
    expect(c.rect).toBeNull();
    expect(c.pendingRect).toEqual({ x1: 1, y1: 2, x2: 3, y2: 4 });
    c.clear();
    expect(c.pendingRect).toBeNull();
    expect(c.rect).toBeNull();
  });

  it("notifies module-level subscribers on every mutation", () => {
    const a = new CropStore();
    const b = new CropStore();
    const fn = vi.fn();
    a.subscribe(fn);
    b.setPending(0, 0, 1, 1);
    b.commitRect(0, 0, 1, 1);
    b.clear();
    a.unsubscribe(fn);
    b.clear();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("triggerCrop calls the shared app handler, if any", () => {
    const a = new CropStore();
    const b = new CropStore();
    expect(() => a.triggerCrop()).not.toThrow();
    const onCrop = vi.fn();
    a.onCrop = onCrop;
    b.triggerCrop();
    expect(onCrop).toHaveBeenCalledTimes(1);
  });
});
