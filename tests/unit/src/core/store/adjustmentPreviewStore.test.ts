import { describe, expect, it, vi } from "vitest";
import { AdjustmentPreviewStore } from "@/core/store/adjustmentPreviewStore";

describe("AdjustmentPreviewStore", () => {
  it("tracks bypassed layers and notifies only on change", () => {
    const s = new AdjustmentPreviewStore();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.setBypassed("a", true);
    s.setBypassed("a", true);
    expect(s.isBypassed("a")).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    s.setBypassed("b", false);
    expect(fn).toHaveBeenCalledTimes(1);
    s.setBypassed("a", false);
    expect(s.isBypassed("a")).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
  });

  it("clear / clearAll are silent when there is nothing to clear", () => {
    const s = new AdjustmentPreviewStore();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.clear("x");
    s.clearAll();
    expect(fn).not.toHaveBeenCalled();
    s.setBypassed("x", true);
    s.setBypassed("y", true);
    s.clear("x");
    expect(s.isBypassed("x")).toBe(false);
    s.clearAll();
    expect(s.isBypassed("y")).toBe(false);
    expect(fn).toHaveBeenCalledTimes(4);
    off();
  });

  it("snapshot is a copy", () => {
    const s = new AdjustmentPreviewStore();
    s.setBypassed("a", true);
    const snap = s.snapshot();
    s.setBypassed("b", true);
    expect([...snap]).toEqual(["a"]);
  });
});
