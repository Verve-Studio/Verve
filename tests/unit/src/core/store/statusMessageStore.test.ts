import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statusMessageStore } from "@/core/store/statusMessageStore";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  statusMessageStore.dismiss();
  vi.useRealTimers();
});

describe("statusMessageStore", () => {
  it("shows the message verbatim and auto-dismisses after 4 s", () => {
    const fn = vi.fn();
    const off = statusMessageStore.subscribe(fn);
    statusMessageStore.show("File saved");
    expect(statusMessageStore.current()).toBe("File saved");
    vi.advanceTimersByTime(3999);
    expect(statusMessageStore.current()).toBe("File saved");
    vi.advanceTimersByTime(1);
    expect(statusMessageStore.current()).toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
    off();
  });

  it("a new message restarts the dismiss timer", () => {
    statusMessageStore.show("a");
    vi.advanceTimersByTime(3000);
    statusMessageStore.show("b");
    vi.advanceTimersByTime(3000);
    expect(statusMessageStore.current()).toBe("b");
    vi.advanceTimersByTime(1000);
    expect(statusMessageStore.current()).toBeNull();
  });

  it("dismiss cancels the timer; unsubscribe stops notifications", () => {
    const fn = vi.fn();
    const off = statusMessageStore.subscribe(fn);
    statusMessageStore.show("x");
    off();
    statusMessageStore.dismiss();
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(statusMessageStore.current()).toBeNull();
  });
});
