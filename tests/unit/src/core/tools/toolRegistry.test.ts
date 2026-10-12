import { describe, expect, it } from "vitest";
import { TOOL_REGISTRY, toolRegistry } from "@/core/tools/index";
import { DEFAULT_TOOL } from "@/core/tools/toolRegistry";
import type { Tool } from "@/types";

const all = toolRegistry.all();

describe("tool registry invariants", () => {
  it("registers every tool once with a unique id", () => {
    const ids = all.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(TOOL_REGISTRY).sort()).toEqual([...ids].sort());
    for (const t of all) {
      expect(toolRegistry.get(t.id)).toBe(t);
      expect(toolRegistry.require(t.id)).toBe(t);
      expect(TOOL_REGISTRY[t.id]).toBe(t);
    }
  });

  it("has the default tool registered and throws for unknown ids", () => {
    expect(toolRegistry.has(DEFAULT_TOOL)).toBe(true);
    expect(() => toolRegistry.require("no-such-tool" as Tool)).toThrow(/no tool registered/);
    expect(toolRegistry.get("no-such-tool" as Tool)).toBeUndefined();
  });

  it("every tool has a label, a valid shortcut and a handler factory", () => {
    for (const t of all) {
      expect(t.label.length, t.id).toBeGreaterThan(0);
      expect(t.shortcut, t.id).toMatch(/^([A-Z]|)$/);
      expect(typeof t.createHandler, t.id).toBe("function");
      expect(t.Options, t.id).toBeTruthy();
    }
  });

  it("no two tools share a toolbar cell", () => {
    const cells = new Map<string, string>();
    for (const t of all) {
      if (!t.placement) continue;
      const { group, row, column } = t.placement;
      expect([0, 1], t.id).toContain(column);
      expect(Number.isInteger(row) && row >= 0, t.id).toBe(true);
      const key = `${group}/${row}/${column}`;
      expect(cells.get(key), `${t.id} collides with ${cells.get(key)} at ${key}`).toBeUndefined();
      cells.set(key, t.id);
    }
  });

  it("toolbarGroups() contains every placed tool exactly once, ordered by group and row", () => {
    const groups = toolRegistry.toolbarGroups();
    const flat = groups.flat(2).filter((t): t is NonNullable<typeof t> => t !== null);
    const placed = all.filter((t) => t.placement !== null);
    expect(flat.map((t) => t.id).sort()).toEqual(placed.map((t) => t.id).sort());
    let prevGroup = -Infinity;
    for (const g of groups) {
      expect(g.length).toBeGreaterThan(0);
      const tools = g.flat().filter((t) => t !== null);
      const groupIds = new Set(tools.map((t) => t!.placement!.group));
      expect(groupIds.size).toBe(1);
      const gid = [...groupIds][0];
      expect(gid).toBeGreaterThan(prevGroup);
      prevGroup = gid;
      let prevRow = -Infinity;
      for (const row of g) {
        expect(row).toHaveLength(2);
        const r = row.find((t) => t !== null)!.placement!.row;
        expect(r).toBeGreaterThan(prevRow);
        prevRow = r;
        row.forEach((t, col) => {
          if (t) expect(t.placement!.column).toBe(col);
        });
      }
    }
  });

  it("tools without placement stay off the toolbar", () => {
    const onBar = new Set(toolRegistry.toolbarGroups().flat(2).filter(Boolean).map((t) => t!.id));
    for (const t of all.filter((x) => x.placement === null)) expect(onBar.has(t.id)).toBe(false);
  });

  it("shortcutCycle targets are registered, share the key, and the cycle closes", () => {
    for (const t of all) {
      if (t.shortcutCycle === undefined) continue;
      const next = toolRegistry.get(t.shortcutCycle);
      expect(next, `${t.id} -> ${t.shortcutCycle}`).toBeDefined();
      expect(next!.shortcut, `${t.id} -> ${next!.id}`).toBe(t.shortcut);
      expect(next!.id).not.toBe(t.id);
      // Walking the chain returns to the start.
      const seen = new Set<Tool>([t.id]);
      let cur = next!;
      while (cur.id !== t.id) {
        expect(cur.shortcutCycle, `${cur.id} breaks the ${t.shortcut} cycle`).toBeDefined();
        expect(seen.has(cur.id)).toBe(false);
        seen.add(cur.id);
        cur = toolRegistry.require(cur.shortcutCycle!);
      }
    }
  });

  it("documented pairs cycle into each other", () => {
    expect(toolRegistry.require("lasso").shortcutCycle).toBe("polygonal-selection");
    expect(toolRegistry.require("polygonal-selection").shortcutCycle).toBe("lasso");
    expect(toolRegistry.require("magic-wand").shortcutCycle).toBe("auto-mask");
    expect(toolRegistry.require("auto-mask").shortcutCycle).toBe("magic-wand");
  });

  it("tools that write pixels declare the flags their history / gating need", () => {
    for (const t of all) {
      if (t.paintsOntoPixelLayer) expect(t.modifiesPixels, t.id).toBe(true);
    }
  });
});

describe("resolveShortcutCycle", () => {
  it("advances within the cycle when a member is active", () => {
    expect(toolRegistry.resolveShortcutCycle("l", "lasso")).toBe("polygonal-selection");
    expect(toolRegistry.resolveShortcutCycle("L", "polygonal-selection")).toBe("lasso");
    expect(toolRegistry.resolveShortcutCycle("W", "magic-wand")).toBe("auto-mask");
  });

  it("enters the cycle at a member when a non-member is active", () => {
    const entry = toolRegistry.resolveShortcutCycle("L", "brush");
    expect(entry === "lasso" || entry === "polygonal-selection").toBe(true);
    expect(toolRegistry.require(entry!).shortcut).toBe("L");
  });

  it("returns null for keys without a cycle", () => {
    const cycleKeys = new Set(all.filter((t) => t.shortcutCycle).map((t) => t.shortcut));
    for (const key of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const out = toolRegistry.resolveShortcutCycle(key, "brush");
      if (cycleKeys.has(key)) expect(out).not.toBeNull();
      else expect(out).toBeNull();
    }
  });
});
