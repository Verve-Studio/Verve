import { beforeEach, describe, expect, it, vi } from "vitest";
import { cursorStore } from "@/ux/main/Canvas/cursorStore";

// requestAnimationFrame is captured so tests flush frames explicitly.
let frames: FrameRequestCallback[] = [];
function flushFrame(): void {
  const pending = frames;
  frames = [];
  for (const cb of pending) cb(0);
}

beforeEach(() => {
  // Run frames a previous test left pending: dropping them would leave the
  // singleton believing a frame is still scheduled.
  flushFrame();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  // Leave the store hidden, with any frame scheduled by the reset flushed.
  cursorStore.hide();
  flushFrame();
});

describe("cursorStore", () => {
  it("coalesces many updates into one notification per frame", () => {
    const fn = vi.fn();
    cursorStore.subscribe(fn);
    for (let i = 0; i < 20; i++) cursorStore.setPosition(i, i * 2);
    cursorStore.setPixelValues([1, 2, 3, 4], false);
    cursorStore.setPixelInfo({ index: 4, color: null });
    expect(fn).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    flushFrame();
    expect(fn).toHaveBeenCalledTimes(1);
    // Fields always hold the latest values.
    expect([cursorStore.x, cursorStore.y, cursorStore.visible]).toEqual([19, 38, true]);
    expect(cursorStore.pixelInfo).toEqual({ index: 4, color: null });
    cursorStore.setPosition(1, 1);
    flushFrame();
    expect(fn).toHaveBeenCalledTimes(2);
    cursorStore.unsubscribe(fn);
  });

  it("setPixelValues records whether values are float", () => {
    cursorStore.setPixelValues([0.5, 2, 0, 1], true);
    expect(cursorStore.pixelIsFloat).toBe(true);
    cursorStore.setPixelValues(null, false);
    expect(cursorStore.pixelValues).toBeNull();
    expect(cursorStore.pixelIsFloat).toBe(false);
  });

  it("hide is a no-op when already hidden", () => {
    expect(cursorStore.visible).toBe(false);
    cursorStore.hide();
    expect(frames).toHaveLength(0);
    cursorStore.setPosition(0, 0);
    flushFrame();
    cursorStore.hide();
    expect(cursorStore.visible).toBe(false);
    expect(frames).toHaveLength(1);
  });
});
