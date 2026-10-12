import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it, vi } from "vitest";
import { effectRegistry } from "@/core/effects";
import {
  ADJUSTMENT_MENU_ITEMS,
  EFFECTS_MENU_ITEMS,
  FILTER_MENU_ITEMS,
} from "@/core/menuConstants";
import type { CustomEffectEntry } from "@/core/effects/CustomShader/customEffectStore";
import {
  buildMenuTree,
  collectActions,
  filterForTarget,
  serializeTree,
  type MenuDeps,
  type MenuNode,
} from "@/ux/main/menu/menuTree";
import { SRC_DIR } from "@tests/paths";

/** The real menu inputs, as App.tsx passes them. */
const baseDeps = (extra: Partial<MenuDeps> = {}): MenuDeps => ({
  pixelFormat: "rgba8",
  isAdjustmentMenuEnabled: true,
  isFiltersMenuEnabled: true,
  adjustmentMenuItems: ADJUSTMENT_MENU_ITEMS,
  effectsMenuItems: EFFECTS_MENU_ITEMS,
  filterMenuItems: FILTER_MENU_ITEMS,
  ...extra,
});

const top = (nodes: MenuNode[], label: string): MenuNode => {
  const n = nodes.find((m) => m.label === label);
  if (!n) throw new Error(`no top-level menu ${label}`);
  return n;
};

function walk(nodes: readonly MenuNode[], fn: (n: MenuNode) => void): void {
  for (const n of nodes) {
    fn(n);
    if (n.submenu) walk(n.submenu, fn);
  }
}

const actionIdsUnder = (node: MenuNode, prefix: string): string[] => {
  const out: string[] = [];
  walk(node.submenu ?? [], (n) => {
    if (n.actionId?.startsWith(prefix)) out.push(n.actionId.slice(prefix.length));
  });
  return out;
};

/** Every `on*` dep is a spy, recorded by name. */
function spyDeps(extra: Partial<MenuDeps> = {}) {
  const spies = new Map<string, ReturnType<typeof vi.fn>>();
  const values = baseDeps(extra) as Record<string, unknown>;
  const deps = new Proxy(values, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop.startsWith("on")) {
        let s = spies.get(prop);
        if (!s) spies.set(prop, (s = vi.fn()));
        return s;
      }
      return undefined;
    },
  }) as MenuDeps;
  return { deps, spies };
}

describe("buildMenuTree: top-level structure", () => {
  it("orders the in-app menus File → Edit → Select → Layer → (Image) → Adjustments → Effects → Filters → View → Help", () => {
    const labels = filterForTarget(buildMenuTree(baseDeps()), "app").map((n) => n.label);
    expect(labels).toEqual([
      "File",
      "Edit",
      "Select",
      "Layer",
      "Image",
      "Adjustments",
      "Effects",
      "Filters",
      "View",
      "Help",
    ]);
  });

  it("macOS gets the app menu first, and Animation appears before View in animation mode", () => {
    const labels = filterForTarget(
      buildMenuTree(baseDeps({ animationMode: true, appName: "Verve" })),
      "mac",
    ).map((n) => n.label);
    expect(labels[0]).toBe("Verve");
    expect(labels.slice(1)).toEqual([
      "File",
      "Edit",
      "Select",
      "Layer",
      "Image",
      "Adjustments",
      "Effects",
      "Filters",
      "Animation",
      "View",
      "Help",
    ]);
  });

  it("hides Adjustments / Effects / Filters for indexed8 documents", () => {
    const labels = filterForTarget(buildMenuTree(baseDeps({ pixelFormat: "indexed8" })), "app").map(
      (n) => n.label,
    );
    expect(labels).not.toContain("Adjustments");
    expect(labels).not.toContain("Effects");
    expect(labels).not.toContain("Filters");
  });

  it("keeps Preferences / Exit / About in the in-app menu only, roles in the mac menu only", () => {
    const tree = buildMenuTree(baseDeps());
    const app = filterForTarget(tree, "app");
    const mac = filterForTarget(tree, "mac");
    const labelsIn = (nodes: MenuNode[]) => {
      const out: string[] = [];
      walk(nodes, (n) => out.push(n.label));
      return out;
    };
    expect(labelsIn(top(app, "File").submenu!)).toEqual(expect.arrayContaining(["Preferences…", "Exit"]));
    expect(labelsIn(top(mac, "File").submenu!)).not.toContain("Exit");
    expect(labelsIn(top(app, "Help").submenu!)).toContain("About Verve");
    expect(labelsIn(top(mac, "Help").submenu!)).not.toContain("About Verve");
    walk(app, (n) => expect(n.role).toBeUndefined());
  });

  it("drops Open DevTools in production", () => {
    const help = (isProd: boolean) =>
      top(buildMenuTree(baseDeps({ isProd })), "Help").submenu!.map((n) => n.label);
    expect(help(false)).toContain("Open DevTools");
    expect(help(true)).not.toContain("Open DevTools");
  });
});

describe("buildMenuTree: registry-driven menus", () => {
  it("Adjustments lists exactly the effects registered under menu.root 'adjustments'", () => {
    const menu = top(buildMenuTree(baseDeps()), "Adjustments");
    const expected = effectRegistry.byMenuRoot("adjustments").map((e) => e.id);
    expect(expected.length).toBeGreaterThan(0);
    expect(actionIdsUnder(menu, "adj:").sort()).toEqual([...expected].sort());
  });

  it("Effects lists every 'effects' effect (Distortion and Custom Effects as submenus)", () => {
    const menu = top(buildMenuTree(baseDeps()), "Effects");
    const expected = effectRegistry.byMenuRoot("effects").map((e) => e.id);
    expect(expected.length).toBeGreaterThan(0);
    expect(actionIdsUnder(menu, "adj:").sort()).toEqual([...expected].sort());
    const subs = menu.submenu!.filter((n) => n.submenu).map((n) => n.label);
    expect(subs).toContain("Custom Effects");
  });

  it("Filters lists every 'filters' effect, instant ones dispatching onInstantFilter", () => {
    const { deps, spies } = spyDeps();
    const menu = top(buildMenuTree(deps), "Filters");
    const filters = effectRegistry.byMenuRoot("filters");
    expect(actionIdsUnder(menu, "filter:").sort()).toEqual(filters.map((e) => e.id).sort());

    const actions = collectActions([menu]);
    const instant = filters.find((e) => e.menu.instant);
    const dialog = filters.find((e) => !e.menu.instant);
    if (instant) {
      actions.get(`filter:${instant.id}`)!();
      expect(spies.get("onInstantFilter")).toHaveBeenCalledWith(instant.id);
    }
    if (dialog) {
      actions.get(`filter:${dialog.id}`)!();
      expect(spies.get("onOpenFilterDialog")).toHaveBeenCalledWith(dialog.id);
    }
  });

  it("menu lists are grouped by submenu tag with separators between groups and sorted within", () => {
    for (const items of [ADJUSTMENT_MENU_ITEMS, FILTER_MENU_ITEMS]) {
      const seen = new Set<string | undefined>();
      let last: string | undefined = "__start__";
      for (const it of items) {
        if (it.group !== last) {
          // A group appears in one contiguous run.
          expect(seen.has(it.group)).toBe(false);
          seen.add(it.group);
          last = it.group;
        }
      }
      for (const g of seen) {
        const labels = items.filter((i) => i.group === g).map((i) => i.label.toLocaleLowerCase());
        expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
      }
    }
  });

  it("disables adjustment entries when the adjustment menu is disabled, and Reduce Colors outside rgba8", () => {
    const off = top(buildMenuTree(baseDeps({ isAdjustmentMenuEnabled: false })), "Adjustments");
    walk(off.submenu!, (n) => {
      if (n.actionId) expect(n.disabled).toBe(true);
    });
    const f32 = top(buildMenuTree(baseDeps({ pixelFormat: "rgba32f" })), "Adjustments");
    const reduce = f32.submenu!.find((n) => n.actionId === "adj:reduce-colors");
    if (reduce) expect(reduce.disabled).toBe(true);
    const other = f32.submenu!.find((n) => n.actionId && n.actionId !== "adj:reduce-colors");
    expect(other?.disabled).toBe(false);
  });

  it("lists saved custom effects, disabling ones that failed to load", () => {
    const customEffects: CustomEffectEntry[] = [
      { path: "/fx/ok.effect", source: "user", label: "Glow", graph: {} as never },
      { path: "/fx/bad.effect", source: "user", label: "Broken", error: "bad json" },
    ];
    const { deps, spies } = spyDeps({ customEffects });
    const effects = top(buildMenuTree(deps), "Effects");
    const custom = effects.submenu!.find((n) => n.label === "Custom Effects")!;
    const ok = custom.submenu!.find((n) => n.actionId === "customEffect:/fx/ok.effect")!;
    const bad = custom.submenu!.find((n) => n.actionId === "customEffect:/fx/bad.effect")!;
    expect(ok.disabled).toBe(false);
    expect(bad).toMatchObject({ label: "Broken (can't be loaded: bad json)", disabled: true });
    ok.action!();
    expect(spies.get("onApplyCustomEffect")).toHaveBeenCalledWith(customEffects[0]);
    expect(custom.submenu!.some((n) => n.label === "No saved effects yet")).toBe(false);
  });
});

describe("buildMenuTree: shortcuts and action ids", () => {
  const shortcutOwners = (target: "app" | "mac") => {
    const owners = new Map<string, string[]>();
    walk(filterForTarget(buildMenuTree(baseDeps({ animationMode: true })), target), (n) => {
      if (!n.shortcut) return;
      owners.set(n.shortcut, [...(owners.get(n.shortcut) ?? []), n.label]);
    });
    return owners;
  };

  it("no two menu items share a shortcut", () => {
    for (const target of ["app", "mac"] as const) {
      for (const [shortcut, labels] of shortcutOwners(target)) {
        expect(labels, shortcut).toHaveLength(1);
      }
    }
  });

  it("Redo is Ctrl+Shift+Z; Ctrl+Y / Ctrl+Shift+Y are Proof Colors / Gamut Warning", () => {
    const owners = shortcutOwners("app");
    expect(owners.get("CmdOrCtrl+Shift+Z")).toEqual(["Redo"]);
    expect(owners.get("CmdOrCtrl+Y")).toEqual(["Proof Colors"]);
    expect(owners.get("CmdOrCtrl+Shift+Y")).toEqual(["Gamut Warning"]);
  });

  it("action ids are unique within each consumer's tree", () => {
    const customEffects: CustomEffectEntry[] = [
      { path: "/a.effect", source: "user", label: "A", graph: {} as never },
    ];
    for (const target of ["app", "mac"] as const) {
      const tree = filterForTarget(
        buildMenuTree(baseDeps({ animationMode: true, recentFiles: ["/x/a.png", "/y/a.png"], customEffects })),
        target,
      );
      const seen = new Set<string>();
      walk(tree, (n) => {
        if (!n.actionId) return;
        expect(seen.has(n.actionId), n.actionId).toBe(false);
        seen.add(n.actionId);
      });
    }
  });

  it("every enabled item with an action id has an action wired to a MenuDeps handler", () => {
    const { deps, spies } = spyDeps({
      animationMode: true,
      recentFiles: ["/photos/cat.png"],
      customEffects: [{ path: "/a.effect", source: "user", label: "A", graph: {} as never }],
      luts: [{ id: "lut1", name: "Film", category: "creative" } as never],
    });
    const tree = buildMenuTree(deps);
    const missing: string[] = [];
    walk(tree, (n) => {
      if (n.actionId && !n.action && !n.disabled) missing.push(n.actionId);
    });
    expect(missing).toEqual([]);

    // Invoke every action that routes to a deps handler (dock / node-editor
    // toggles call stores directly and are skipped).
    walk(tree, (n) => {
      if (!n.action || /^(togglePanel:|toggle\w+Editor$|resetPanelLayout$)/.test(n.actionId ?? "")) return;
      n.action();
    });
    const notCalled = [...spies].filter(([, s]) => s.mock.calls.length === 0).map(([k]) => k);
    expect(notCalled).toEqual([]);
    expect(spies.get("onOpenRecent")).toHaveBeenCalledWith("/photos/cat.png");
    expect(spies.get("onSetViewTransform")).toHaveBeenCalledWith("lut1");
    expect(spies.get("onSetViewTransform")).toHaveBeenCalledWith(null);
    expect(spies.get("onSetAnimationMode")).toHaveBeenCalledWith(false);
    expect(spies.get("onLayerRotate")).toHaveBeenCalledWith("270cw");
    expect(spies.get("onSetColorMode")).toHaveBeenCalledWith("indexed8");
  });

  it("every handler the menu reads is implemented in App.tsx's menuHandlersNow", () => {
    const { deps, spies } = spyDeps({ animationMode: true, recentFiles: ["/a.png"] });
    walk(buildMenuTree(deps), (n) => n.action?.());
    const src = readFileSync(resolve(SRC_DIR, "App.tsx"), "utf8");
    const start = src.indexOf("const menuHandlersNow: MenuHandlerImpls = {");
    const end = src.indexOf("const menuHandlersRef", start);
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, end);
    const implemented = new Set([...block.matchAll(/^\s*(on\w+)\s*:/gm)].map((m) => m[1]));
    // App.tsx maps these two from the active-layer variants.
    implemented.add("onRasterizeLayer");
    implemented.add("onUngroupLayers");
    const missing = [...spies.keys()].filter((k) => !implemented.has(k));
    expect(missing).toEqual([]);
  });
});

describe("menu tree helpers", () => {
  it("serializeTree strips actions but keeps the display state", () => {
    const tree = buildMenuTree(baseDeps({ showGrid: true, onToggleGrid: () => {} }));
    const view = serializeTree(tree).find((n) => n.label === "View")!;
    const grid = view.submenu!.find((n) => n.actionId === "toggleGrid")!;
    expect(grid).toEqual({ label: "Show Grid", actionId: "toggleGrid", shortcut: "CmdOrCtrl+'", checked: true });
    expect(() => structuredClone(serializeTree(tree))).not.toThrow();
  });

  it("filterForTarget drops hidden nodes and containers left empty", () => {
    const nodes: MenuNode[] = [
      { label: "Hidden", hidden: true, action: () => {} },
      { label: "MacOnly", submenu: [{ label: "x", targets: "mac" }] },
      { label: "Kept", submenu: [{ label: "y" }, { label: "z", targets: "mac" }] },
    ];
    expect(filterForTarget(nodes, "app")).toEqual([{ label: "Kept", submenu: [{ label: "y" }] }]);
  });

  it("the Animation menu reflects play state and blocks spritesheet actions for cell animation", () => {
    const anim = (extra: Partial<MenuDeps>) =>
      top(buildMenuTree(baseDeps({ animationMode: true, ...extra })), "Animation").submenu!;
    expect(anim({ isPlaying: true })[0].label).toBe("Pause");
    expect(anim({ isPlaying: false })[0].label).toBe("Play");
    const cell = anim({ cellAnimationActive: true });
    expect(cell.find((n) => n.actionId === "nextAnimation")?.disabled).toBe(true);
    expect(cell.find((n) => n.actionId === "exportSpritesheetJson")?.disabled).toBe(true);
    expect(cell.find((n) => n.actionId === "nextFrame")?.disabled).toBe(false);
  });

  it("recent files show base names; an empty list shows a disabled placeholder", () => {
    const recent = (files: string[]) =>
      top(buildMenuTree(baseDeps({ recentFiles: files })), "File").submenu!.find((n) => n.label === "Open Recent")!
        .submenu!;
    expect(recent(["C:\\pics\\a.png", "/home/b.verve"]).map((n) => n.label)).toEqual([
      "a.png",
      "b.verve",
      "",
      "Clear Recent",
    ]);
    expect(recent([])).toEqual([{ label: "No Recent Files", disabled: true }]);
  });
});
