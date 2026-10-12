import { describe, expect, it, vi } from "vitest";
import type { Brush } from "@/types";
import { makeStarterBrushes } from "@/core/tools/Brush/brushPresets";
import { BrushOverridesStore } from "@/core/store/brushOverridesStore";

const brush: Brush = makeStarterBrushes()[0];

describe("BrushOverridesStore", () => {
  it("applyTo returns the canonical brush itself when not overridden", () => {
    const s = new BrushOverridesStore();
    expect(s.applyTo(brush)).toBe(brush);
    expect(s.get(brush.id)).toBeNull();
    expect(s.hasAny()).toBe(false);
  });

  it("patches merge shallowly and shadow the canonical fields", () => {
    const s = new BrushOverridesStore();
    s.patch(brush.id, { name: "Tweaked" });
    s.patch(brush.id, { tip: { ...brush.tip, size: 99 } });
    const eff = s.applyTo(brush);
    expect(eff).not.toBe(brush);
    expect(eff.name).toBe("Tweaked");
    expect(eff.tip.size).toBe(99);
    expect(brush.tip.size).not.toBe(99);
    expect(s.get(brush.id)).toEqual({ name: "Tweaked", tip: { ...brush.tip, size: 99 } });
    expect([...s.modifiedIds()]).toEqual([brush.id]);
    expect(s.hasAny()).toBe(true);
  });

  it("clear drops the override and reports whether there was one", () => {
    const s = new BrushOverridesStore();
    const fn = vi.fn();
    s.subscribe(fn);
    expect(s.clear(brush.id)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    s.patch(brush.id, { name: "x" });
    expect(s.clear(brush.id)).toBe(true);
    expect(s.has(brush.id)).toBe(false);
    expect(s.applyTo(brush)).toBe(brush);
    s.unsubscribe(fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("overrides are per document (instance)", () => {
    const a = new BrushOverridesStore();
    const b = new BrushOverridesStore();
    a.patch(brush.id, { name: "A" });
    expect(b.has(brush.id)).toBe(false);
  });

  it("modifiedIds is a snapshot", () => {
    const s = new BrushOverridesStore();
    s.patch("a", {});
    const ids = s.modifiedIds();
    s.patch("b", {});
    expect([...ids]).toEqual(["a"]);
  });
});
