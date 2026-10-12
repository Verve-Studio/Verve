import { afterEach, describe, expect, it, vi } from "vitest";
import { viewportCommands } from "@/core/store/viewportCommands";

afterEach(() => {
  viewportCommands.setScroll(0, 0);
  viewportCommands.fitToWindow = null;
});

describe("viewportCommands", () => {
  it("setScroll stores the offset and notifies only on change", () => {
    const fn = vi.fn();
    viewportCommands.subscribeScroll(fn);
    viewportCommands.setScroll(10, 20);
    viewportCommands.setScroll(10, 20);
    expect(viewportCommands.scrollLeft).toBe(10);
    expect(viewportCommands.scrollTop).toBe(20);
    expect(fn).toHaveBeenCalledTimes(1);
    viewportCommands.setScroll(10, 21);
    expect(fn).toHaveBeenCalledTimes(2);
    viewportCommands.unsubscribeScroll(fn);
    viewportCommands.setScroll(0, 0);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("fitToWindow is a registered callback (null until Canvas mounts)", () => {
    expect(viewportCommands.fitToWindow).toBeNull();
    const fit = vi.fn();
    viewportCommands.fitToWindow = fit;
    viewportCommands.fitToWindow?.();
    expect(fit).toHaveBeenCalledTimes(1);
  });
});
