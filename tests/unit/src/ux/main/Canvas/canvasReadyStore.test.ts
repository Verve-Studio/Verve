import { describe, expect, it, vi } from "vitest";
import { canvasReadyStore } from "@/ux/main/Canvas/canvasReadyStore";

describe("canvasReadyStore", () => {
  it("markReady records the key and notifies subscribers", () => {
    const fn = vi.fn();
    const off = canvasReadyStore.subscribe(fn);
    canvasReadyStore.markReady("tab-1-0");
    expect(canvasReadyStore.readyKey).toBe("tab-1-0");
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    canvasReadyStore.markReady("tab-1-1");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(canvasReadyStore.readyKey).toBe("tab-1-1");
  });

  it("a kept view is handed out exactly once", () => {
    expect(canvasReadyStore.takeKeptView()).toBeNull();
    canvasReadyStore.keepViewOnNextReady({ left: 10, top: 20 });
    expect(canvasReadyStore.takeKeptView()).toEqual({ left: 10, top: 20 });
    expect(canvasReadyStore.takeKeptView()).toBeNull();
    canvasReadyStore.keepViewOnNextReady({ left: 1, top: 1 });
    canvasReadyStore.keepViewOnNextReady(null);
    expect(canvasReadyStore.takeKeptView()).toBeNull();
  });
});
