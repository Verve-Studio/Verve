import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notificationStore } from "@/core/store/notificationStore";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  notificationStore.dismiss();
  vi.useRealTimers();
});

describe("notificationStore", () => {
  it("shows an error with a warning prefix and auto-dismisses after 6 s", () => {
    const fn = vi.fn();
    const off = notificationStore.subscribe(fn);
    notificationStore.error("Out of memory");
    expect(notificationStore.current()).toBe("⚠ Out of memory");
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5999);
    expect(notificationStore.current()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(notificationStore.current()).toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
    off();
  });

  it("latest message wins and restarts the timer", () => {
    notificationStore.error("first");
    vi.advanceTimersByTime(4000);
    notificationStore.error("second");
    expect(notificationStore.current()).toBe("⚠ second");
    vi.advanceTimersByTime(4000);
    // The first message's timer must not dismiss the second one.
    expect(notificationStore.current()).toBe("⚠ second");
    vi.advanceTimersByTime(2000);
    expect(notificationStore.current()).toBeNull();
  });

  it("dismiss clears immediately and cancels the pending timer", () => {
    const fn = vi.fn();
    notificationStore.error("x");
    const off = notificationStore.subscribe(fn);
    notificationStore.dismiss();
    expect(notificationStore.current()).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });
});
