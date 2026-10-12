import React from "react";
import { describe, expect, it } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import type {
  CompositeLayerState,
  GroupLayerState,
  LayerState,
  LinkedLayerState,
  MaskLayerState,
  PixelLayerState,
} from "@/types";
import type { EffectLayerState } from "@/core/effects/effectTypes";
import {
  AppProvider,
  appShellEqual,
  shallowEqual,
  shallowEqual2,
  useAppContext,
  useAppDispatch,
  useAppSelector,
  useAppStore,
  useGetAppState,
  type AppAction,
  type AppStore,
} from "@/core/store/AppContext";
import { DEFAULT_SWATCHES } from "@/core/store/tabTypes";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function newStore(): AppStore {
  const { result } = renderHook(() => useAppStore(), { wrapper: AppProvider });
  return result.current;
}

/** A store whose state has been driven by `actions`. */
function storeWith(...actions: AppAction[]): AppStore {
  const s = newStore();
  for (const a of actions) s.dispatch(a);
  return s;
}

const px = (id: string, extra: Partial<PixelLayerState> = {}): PixelLayerState => ({
  id,
  name: id,
  visible: true,
  opacity: 1,
  locked: false,
  blendMode: "normal",
  ...extra,
});

const group = (id: string, childIds: string[], extra: Partial<GroupLayerState> = {}): GroupLayerState => ({
  id,
  name: id,
  visible: true,
  opacity: 1,
  locked: false,
  blendMode: "pass-through",
  type: "group",
  collapsed: false,
  childIds,
  ...extra,
});

const composite = (
  id: string,
  childIds: string[],
  extra: Partial<CompositeLayerState> = {},
): CompositeLayerState => ({
  id,
  name: id,
  visible: true,
  opacity: 1,
  locked: false,
  blendMode: "normal",
  type: "composite",
  collapsed: false,
  childIds,
  ...extra,
});

const mask = (id: string, parentId: string): MaskLayerState => ({
  id,
  name: id,
  visible: true,
  type: "mask",
  parentId,
});

const adjustment = (id: string, parentId: string): EffectLayerState =>
  ({
    id,
    name: id,
    visible: true,
    opacity: 1,
    locked: false,
    blendMode: "normal",
    type: "adjustment",
    parentId,
    effectType: "brightness-contrast",
    params: {},
    hasMask: false,
  }) as unknown as EffectLayerState;

/** Store with the given flat layer list (via RESTORE_LAYERS). */
function storeWithLayers(layers: LayerState[], activeLayerId: string | null = null): AppStore {
  return storeWith({
    type: "RESTORE_LAYERS",
    payload: { layers, activeLayerId: activeLayerId ?? layers[layers.length - 1]?.id ?? null },
  });
}

const ids = (s: AppStore): string[] => s.getState().layers.map((l) => l.id);
const layer = (s: AppStore, id: string): LayerState => s.getState().layers.find((l) => l.id === id)!;
const childIds = (s: AppStore, id: string): string[] =>
  (layer(s, id) as GroupLayerState | CompositeLayerState).childIds;

const tabPayload = {
  width: 64,
  height: 32,
  backgroundFill: "transparent" as const,
  layers: [px("t1"), px("t2")],
  activeLayerId: "t2",
  zoom: 3,
  tiledMode: true,
  showTileGrid: true,
};

// ─── Store mechanics ─────────────────────────────────────────────────────────

describe("app store", () => {
  it("starts with a single Background layer, rgba8, at 512²", () => {
    const st = newStore().getState();
    expect(st.layers.map((l) => l.id)).toEqual(["layer-0"]);
    expect(st.activeLayerId).toBe("layer-0");
    expect(st.selectedLayerIds).toEqual([]);
    expect(st.pixelFormat).toBe("rgba8");
    expect(st.canvas.width).toBe(512);
    expect(st.swatches).toBe(DEFAULT_SWATCHES);
  });

  it("each provider owns its own store", () => {
    const a = newStore();
    const b = newStore();
    a.dispatch({ type: "SET_TOOL", payload: "brush" });
    expect(b.getState().activeTool).toBe("pencil");
  });

  it("notifies subscribers on change, not on no-op actions", () => {
    const s = newStore();
    let calls = 0;
    const off = s.subscribe(() => calls++);
    const before = s.getState();
    s.dispatch({ type: "SET_PRIMARY_COLOR", payload: { ...before.primaryColor } });
    s.dispatch({ type: "SET_ZOOM", payload: before.canvas.zoom });
    s.dispatch({ type: "NOT_AN_ACTION" } as unknown as AppAction);
    expect(s.getState()).toBe(before);
    expect(calls).toBe(0);
    s.dispatch({ type: "SET_ZOOM", payload: 2 });
    expect(calls).toBe(1);
    off();
    s.dispatch({ type: "SET_ZOOM", payload: 4 });
    expect(calls).toBe(1);
  });

  it("a listener may unsubscribe another during notification without breaking the loop", () => {
    const s = newStore();
    const seen: string[] = [];
    let offB: () => void = () => {};
    const offA = s.subscribe(() => {
      seen.push("a");
      offB();
    });
    offB = s.subscribe(() => seen.push("b"));
    s.dispatch({ type: "SET_TOOL", payload: "brush" });
    // The listener snapshot taken before the loop still reaches b once.
    expect(seen).toEqual(["a", "b"]);
    s.dispatch({ type: "SET_TOOL", payload: "eraser" });
    expect(seen).toEqual(["a", "b", "a"]);
    offA();
  });

  it("hooks throw outside an AppProvider", () => {
    const err = console.error;
    console.error = () => {};
    try {
      expect(() => renderHook(() => useAppDispatch())).toThrow(/AppProvider/);
    } finally {
      console.error = err;
    }
  });
});

describe("subscription hooks", () => {
  function setup<T>(hook: () => T): {
    store: AppStore;
    renders: () => number;
    value: () => T;
  } {
    let count = 0;
    let store!: AppStore;
    const { result } = renderHook(
      () => {
        count++;
        store = useAppStore();
        return hook();
      },
      { wrapper: AppProvider },
    );
    return { store, renders: () => count, value: () => result.current };
  }

  it("useAppSelector re-renders only when its slice changes", () => {
    const { store, renders, value } = setup(() => useAppSelector((s) => s.activeTool));
    const initial = renders();
    act(() => store.dispatch({ type: "SET_ZOOM", payload: 3 }));
    act(() => store.dispatch({ type: "SET_PRIMARY_COLOR", payload: { r: 9, g: 9, b: 9, a: 1 } }));
    expect(renders()).toBe(initial);
    act(() => store.dispatch({ type: "SET_TOOL", payload: "brush" }));
    expect(renders()).toBe(initial + 1);
    expect(value()).toBe("brush");
  });

  it("a fresh-object selector needs shallowEqual to stay quiet", () => {
    const loose = setup(() => useAppSelector((s) => ({ tool: s.activeTool, w: s.canvas.width })));
    const strict = setup(() =>
      useAppSelector((s) => ({ tool: s.activeTool, w: s.canvas.width }), shallowEqual),
    );
    const l0 = loose.renders();
    const s0 = strict.renders();
    act(() => loose.store.dispatch({ type: "SET_ZOOM", payload: 5 }));
    act(() => strict.store.dispatch({ type: "SET_ZOOM", payload: 5 }));
    expect(loose.renders()).toBeGreaterThan(l0);
    expect(strict.renders()).toBe(s0);
    const before = strict.value();
    act(() => strict.store.dispatch({ type: "SET_ZOOM", payload: 6 }));
    // Equal slices keep the previous object identity.
    expect(strict.value()).toBe(before);
    act(() => strict.store.dispatch({ type: "SET_TOOL", payload: "eraser" }));
    expect(strict.renders()).toBe(s0 + 1);
    expect(strict.value()).toEqual({ tool: "eraser", w: 512 });
  });

  it("shallowEqual2 handles nested picked sub-objects", () => {
    const { store, renders } = setup(() =>
      useAppSelector(
        (s) => ({ canvas: { width: s.canvas.width, height: s.canvas.height }, layers: s.layers }),
        shallowEqual2,
      ),
    );
    const r0 = renders();
    act(() => store.dispatch({ type: "SET_ZOOM", payload: 2 }));
    act(() => store.dispatch({ type: "TOGGLE_GRID" }));
    expect(renders()).toBe(r0);
    act(() => store.dispatch({ type: "RESIZE_CANVAS", payload: { width: 100, height: 100 } }));
    expect(renders()).toBe(r0 + 1);
  });

  it("a selector closing over props is re-evaluated when the prop changes", () => {
    let store!: AppStore;
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => {
        store = useAppStore();
        return useAppSelector((s) => s.layers.find((l) => l.id === id)?.name ?? null);
      },
      { wrapper: AppProvider, initialProps: { id: "layer-0" } },
    );
    expect(result.current).toBe("Background");
    act(() => store.dispatch({ type: "ADD_LAYER", payload: px("p1", { name: "Paint" }) }));
    rerender({ id: "p1" });
    expect(result.current).toBe("Paint");
  });

  it("useAppDispatch never re-renders and is stable", () => {
    const { store, renders, value } = setup(() => useAppDispatch());
    const first = value();
    const r0 = renders();
    act(() => store.dispatch({ type: "SET_TOOL", payload: "brush" }));
    act(() => first({ type: "SET_ZOOM", payload: 8 }));
    expect(renders()).toBe(r0);
    expect(value()).toBe(first);
    expect(store.getState().canvas.zoom).toBe(8);
  });

  it("useGetAppState reads live state without subscribing", () => {
    const { store, renders, value } = setup(() => useGetAppState());
    const r0 = renders();
    act(() => store.dispatch({ type: "SET_TOOL", payload: "brush" }));
    expect(renders()).toBe(r0);
    expect(value()().activeTool).toBe("brush");
  });

  it("useAppContext is a whole-state subscription", () => {
    const { store, renders, value } = setup(() => useAppContext());
    const r0 = renders();
    act(() => store.dispatch({ type: "SET_ZOOM", payload: 7 }));
    expect(renders()).toBe(r0 + 1);
    expect(value().state.canvas.zoom).toBe(7);
    expect(value().dispatch).toBe(store.dispatch);
  });

  it("only the component reading a slice re-renders (component tree)", () => {
    const counts = { tool: 0, zoom: 0, dispatchOnly: 0 };
    let store!: AppStore;
    function Tool(): React.JSX.Element {
      counts.tool++;
      return <span>{useAppSelector((s) => s.activeTool)}</span>;
    }
    function Zoom(): React.JSX.Element {
      counts.zoom++;
      return <span>{useAppSelector((s) => s.canvas.zoom)}</span>;
    }
    function DispatchOnly(): React.JSX.Element {
      counts.dispatchOnly++;
      useAppDispatch();
      store = useAppStore();
      return <span />;
    }
    render(
      <AppProvider>
        <Tool />
        <Zoom />
        <DispatchOnly />
      </AppProvider>,
    );
    const c0 = { ...counts };
    act(() => store.dispatch({ type: "SET_ZOOM", payload: 4 }));
    expect(counts).toEqual({ ...c0, zoom: c0.zoom + 1 });
  });
});

describe("shallowEqual / shallowEqual2 / appShellEqual", () => {
  it("shallowEqual compares own keys with Object.is", () => {
    const arr = [1];
    expect(shallowEqual({ a: 1, b: arr }, { a: 1, b: arr })).toBe(true);
    expect(shallowEqual({ a: 1, b: [1] }, { a: 1, b: [1] })).toBe(false);
    expect(shallowEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(shallowEqual({ a: undefined }, { b: undefined } as unknown as { a: undefined })).toBe(false);
    expect(shallowEqual(NaN, NaN)).toBe(true);
    expect(shallowEqual<unknown>(null, {})).toBe(false);
    expect(shallowEqual(1, 2)).toBe(false);
  });

  it("shallowEqual2 goes one level deeper for plain objects only", () => {
    const layers: number[] = [];
    expect(shallowEqual2({ c: { w: 1, h: 2 }, layers }, { c: { w: 1, h: 2 }, layers })).toBe(true);
    expect(shallowEqual2({ c: { w: 1 } }, { c: { w: 2 } })).toBe(false);
    // Arrays vs objects, and two levels deep, are not equal.
    expect(shallowEqual2({ c: [1] }, { c: { 0: 1 } } as unknown as { c: number[] })).toBe(false);
    expect(shallowEqual2({ c: { d: { e: 1 } } }, { c: { d: { e: 1 } } })).toBe(false);
    expect(shallowEqual2({ c: null }, { c: {} } as unknown as { c: null })).toBe(false);
  });

  it("appShellEqual ignores colours and zoom but nothing else", () => {
    const s = newStore();
    const a = s.getState();
    s.dispatch({ type: "SET_PRIMARY_COLOR", payload: { r: 1, g: 2, b: 3, a: 1 } });
    s.dispatch({ type: "SET_SECONDARY_COLOR", payload: { r: 1, g: 2, b: 3, a: 1 } });
    s.dispatch({ type: "SET_ZOOM", payload: 9 });
    expect(appShellEqual(a, s.getState())).toBe(true);
    s.dispatch({ type: "TOGGLE_GRID" });
    expect(appShellEqual(a, s.getState())).toBe(false);
    const b = s.getState();
    s.dispatch({ type: "SET_TOOL", payload: "brush" });
    expect(appShellEqual(b, s.getState())).toBe(false);
  });
});

// ─── Reducer: selection reset invariant ──────────────────────────────────────

describe("actions that reset the layer stack clear selectedLayerIds", () => {
  const cases: [string, AppAction][] = [
    ["SET_ACTIVE_LAYER", { type: "SET_ACTIVE_LAYER", payload: "a" }],
    ["REORDER_LAYERS", { type: "REORDER_LAYERS", payload: [px("b"), px("a")] }],
    ["RESTORE_LAYERS", { type: "RESTORE_LAYERS", payload: { layers: [px("a")], activeLayerId: "a" } }],
    ["NEW_CANVAS", { type: "NEW_CANVAS", payload: { width: 8, height: 8, backgroundFill: "white" } }],
    [
      "OPEN_FILE",
      { type: "OPEN_FILE", payload: { width: 8, height: 8, layers: [px("o")], activeLayerId: "o" } },
    ],
    ["RESTORE_TAB", { type: "RESTORE_TAB", payload: tabPayload }],
    ["SWITCH_TAB", { type: "SWITCH_TAB", payload: tabPayload }],
  ];
  for (const [name, action] of cases) {
    it(name, () => {
      const s = storeWithLayers([px("a"), px("b")], "a");
      s.dispatch({ type: "SET_SELECTED_LAYERS", payload: ["a", "b"] });
      expect(s.getState().selectedLayerIds).toEqual(["a", "b"]);
      s.dispatch(action);
      expect(s.getState().selectedLayerIds).toEqual([]);
    });
  }

  it("other layer edits keep the multi-selection", () => {
    const s = storeWithLayers([px("a"), px("b")], "a");
    s.dispatch({ type: "SET_SELECTED_LAYERS", payload: ["a", "b"] });
    s.dispatch({ type: "RENAME_LAYER", payload: { id: "a", name: "A" } });
    s.dispatch({ type: "SET_LAYER_OPACITY", payload: { id: "a", opacity: 0.5 } });
    expect(s.getState().selectedLayerIds).toEqual(["a", "b"]);
  });
});

// ─── Reducer: documents & tabs ───────────────────────────────────────────────

describe("document actions", () => {
  it("NEW_CANVAS resets the document but keeps app-level settings", () => {
    const s = storeWithLayers([px("a"), px("b")]);
    s.dispatch({ type: "SET_TOOL", payload: "brush" });
    s.dispatch({ type: "SET_PIXEL_FORMAT", payload: "rgba32f" });
    s.dispatch({ type: "ADD_SWATCH", payload: { r: 1, g: 1, b: 1, a: 255 } });
    s.dispatch({ type: "ADD_GUIDE", payload: { id: "g", axis: "h", position: 3 } });
    s.dispatch({ type: "SET_ZOOM", payload: 4 });
    s.dispatch({ type: "SET_HISTORY", payload: { canUndo: true, canRedo: true } });
    s.dispatch({ type: "SET_SPRITESHEET", payload: { enabled: true } });
    s.dispatch({ type: "SET_ICC_PROFILE", payload: new Uint8Array([1]) });
    const key = s.getState().canvas.key;

    s.dispatch({ type: "NEW_CANVAS", payload: { width: 100, height: 50, backgroundFill: "black" } });
    const st = s.getState();
    expect(st.layers.map((l) => l.id)).toEqual(["layer-0"]);
    expect(st.activeLayerId).toBe("layer-0");
    expect(st.pixelFormat).toBe("rgba8");
    expect(st.swatches).toBe(DEFAULT_SWATCHES);
    expect(st.swatchGroups).toEqual([]);
    expect(st.canvas).toMatchObject({ width: 100, height: 50, backgroundFill: "black", zoom: 1, guides: [] });
    expect(st.canvas.key).toBe(key + 1);
    expect(st.history).toEqual({ canUndo: false, canRedo: false });
    expect(st.spritesheet.enabled).toBe(false);
    expect(st.iccProfile).toBeUndefined();
    expect(st.activeTool).toBe("brush");
  });

  it("NEW_CANVAS honours an explicit format and palette", () => {
    const pal = [{ r: 1, g: 2, b: 3, a: 255 }];
    const s = storeWith({
      type: "NEW_CANVAS",
      payload: { width: 4, height: 4, backgroundFill: "white", pixelFormat: "indexed8", swatches: pal },
    });
    expect(s.getState().pixelFormat).toBe("indexed8");
    expect(s.getState().swatches).toBe(pal);
  });

  it("OPEN_FILE loads layers, format and ICC profile and remounts the canvas", () => {
    const icc = new Uint8Array([7]);
    const s = storeWith({ type: "SET_ZOOM", payload: 3 });
    const key = s.getState().canvas.key;
    s.dispatch({
      type: "OPEN_FILE",
      payload: { width: 30, height: 20, layers: [px("f")], activeLayerId: "f", pixelFormat: "rgba32f", iccProfile: icc },
    });
    const st = s.getState();
    expect(ids(s)).toEqual(["f"]);
    expect(st.pixelFormat).toBe("rgba32f");
    expect(st.iccProfile).toBe(icc);
    expect(st.canvas).toMatchObject({ width: 30, height: 20, zoom: 1 });
    expect(st.canvas.key).toBe(key + 1);
  });

  it("RESTORE_TAB remounts and resets history; swatches only change when given", () => {
    const pal = [{ r: 5, g: 5, b: 5, a: 255 }];
    const s = storeWith({ type: "SET_SWATCHES", payload: pal });
    const key = s.getState().canvas.key;
    s.dispatch({ type: "SET_HISTORY", payload: { canUndo: true, canRedo: false } });
    s.dispatch({ type: "RESTORE_TAB", payload: tabPayload });
    const st = s.getState();
    expect(st.canvas.key).toBe(key + 1);
    expect(st.history).toEqual({ canUndo: false, canRedo: false });
    expect(st.swatches).toBe(pal);
    expect(st.canvas).toMatchObject({ width: 64, height: 32, zoom: 3, tiledMode: true, showTileGrid: true });
    expect(st.pixelFormat).toBe("rgba8");
    s.dispatch({ type: "RESTORE_TAB", payload: { ...tabPayload, swatches: DEFAULT_SWATCHES, swatchGroups: [] } });
    expect(s.getState().swatches).toBe(DEFAULT_SWATCHES);
  });

  it("SWITCH_TAB keeps the canvas mounted and history, and turns animation modes off", () => {
    const s = storeWith(
      { type: "SET_HISTORY", payload: { canUndo: true, canRedo: false } },
      { type: "SET_ANIMATION_MODE", payload: true },
      { type: "SET_PALETTE_ANIMATION", payload: { enabled: true } },
    );
    const key = s.getState().canvas.key;
    s.dispatch({ type: "SWITCH_TAB", payload: { ...tabPayload, pixelFormat: "indexed8" } });
    const st = s.getState();
    expect(st.canvas.key).toBe(key);
    expect(st.history).toEqual({ canUndo: true, canRedo: false });
    expect(st.animationMode).toBe(false);
    expect(st.paletteAnimation.enabled).toBe(false);
    expect(st.pixelFormat).toBe("indexed8");
    expect(st.activeLayerId).toBe("t2");
  });

  it("RESIZE_CANVAS changes size without bumping the canvas key", () => {
    const s = newStore();
    const key = s.getState().canvas.key;
    s.dispatch({ type: "RESIZE_CANVAS", payload: { width: 10, height: 20 } });
    expect(s.getState().canvas).toMatchObject({ width: 10, height: 20, key });
  });

  it("SET_PIXEL_FORMAT / SET_ICC_PROFILE / SET_HISTORY set their fields", () => {
    const s = newStore();
    s.dispatch({ type: "SET_PIXEL_FORMAT", payload: "rgba32f" });
    s.dispatch({ type: "SET_ICC_PROFILE", payload: undefined });
    s.dispatch({ type: "SET_HISTORY", payload: { canUndo: true, canRedo: true } });
    expect(s.getState().pixelFormat).toBe("rgba32f");
    expect(s.getState().iccProfile).toBeUndefined();
    expect(s.getState().history).toEqual({ canUndo: true, canRedo: true });
  });
});

// ─── Reducer: layers ─────────────────────────────────────────────────────────

describe("layer actions", () => {
  it("ADD_* layer actions append and activate", () => {
    const s = newStore();
    s.dispatch({ type: "ADD_LAYER", payload: px("a") });
    expect(s.getState().activeLayerId).toBe("a");
    s.dispatch({ type: "ADD_TEXT_LAYER", payload: { ...px("t"), type: "text" } as never });
    s.dispatch({ type: "ADD_SHAPE_LAYER", payload: { ...px("s"), type: "shape" } as never });
    s.dispatch({ type: "ADD_PATH_LAYER", payload: { ...px("p"), type: "path" } as never });
    s.dispatch({ type: "ADD_FRAME_LAYER", payload: { ...px("f"), type: "frame" } as never });
    s.dispatch({ type: "ADD_LINKED_LAYER", payload: { ...px("l"), type: "linked", refreshNonce: 0 } as never });
    expect(ids(s)).toEqual(["layer-0", "a", "t", "s", "p", "f", "l"]);
    expect(s.getState().activeLayerId).toBe("l");
  });

  it("UPDATE_* layer actions replace the layer by id in place", () => {
    const s = storeWithLayers([px("a"), { ...px("t"), type: "text" } as never, px("b")]);
    const updated = { ...px("t", { name: "New" }), type: "text" } as never;
    s.dispatch({ type: "UPDATE_TEXT_LAYER", payload: updated });
    expect(layer(s, "t")).toBe(updated);
    expect(ids(s)).toEqual(["a", "t", "b"]);
  });

  it("INSERT_LAYER_ABOVE inserts after the reference layer (or at the end)", () => {
    const s = storeWithLayers([px("a"), px("b")]);
    s.dispatch({ type: "INSERT_LAYER_ABOVE", payload: { layer: px("n"), aboveId: "a" } });
    expect(ids(s)).toEqual(["a", "n", "b"]);
    s.dispatch({ type: "INSERT_LAYER_ABOVE", payload: { layer: px("m"), aboveId: "missing" } });
    expect(ids(s)).toEqual(["a", "n", "b", "m"]);
    expect(s.getState().activeLayerId).toBe("m");
  });

  it("REMOVE_LAYER never removes the last layer or an unknown id", () => {
    const s = newStore();
    const st = s.getState();
    s.dispatch({ type: "REMOVE_LAYER", payload: "layer-0" });
    expect(s.getState()).toBe(st);
    const t = storeWithLayers([px("a"), px("b")]);
    const st2 = t.getState();
    t.dispatch({ type: "REMOVE_LAYER", payload: "zzz" });
    expect(t.getState()).toBe(st2);
  });

  it("REMOVE_LAYER on a group removes its subtree and attached masks / adjustments", () => {
    const s = storeWithLayers(
      [
        px("bg"),
        px("c1"),
        mask("c1-mask", "c1"),
        adjustment("c1-adj", "c1"),
        px("c2"),
        group("inner", ["c2"]),
        group("g", ["c1", "inner"]),
        px("top"),
      ],
      "c2",
    );
    s.dispatch({ type: "SET_SELECTED_LAYERS", payload: ["c1", "top"] });
    s.dispatch({ type: "SET_OPEN_ADJUSTMENT", payload: "c1-adj" });
    s.dispatch({ type: "REMOVE_LAYER", payload: "g" });
    const st = s.getState();
    expect(ids(s)).toEqual(["bg", "top"]);
    // The active layer was removed: fall back to the topmost remaining.
    expect(st.activeLayerId).toBe("top");
    expect(st.selectedLayerIds).toEqual(["top"]);
    expect(st.openAdjustmentLayerId).toBeNull();
  });

  it("REMOVE_LAYER prunes the id from its parent and keeps an untouched selection's identity", () => {
    const s = storeWithLayers([px("a"), px("b"), group("g", ["a", "b"])], "g");
    s.dispatch({ type: "SET_SELECTED_LAYERS", payload: ["g"] });
    const sel = s.getState().selectedLayerIds;
    s.dispatch({ type: "REMOVE_LAYER", payload: "a" });
    expect(childIds(s, "g")).toEqual(["b"]);
    expect(s.getState().activeLayerId).toBe("g");
    expect(s.getState().selectedLayerIds).toBe(sel);
  });

  it("REMOVE_LAYER is blocked inside a locked composite", () => {
    const s = storeWithLayers([px("a"), px("b"), composite("c", ["a"], { locked: true })]);
    const st = s.getState();
    s.dispatch({ type: "REMOVE_LAYER", payload: "a" });
    expect(s.getState()).toBe(st);
  });

  it("SET_ACTIVE_LAYER closes an open adjustment panel that belongs to another layer", () => {
    const s = storeWithLayers([px("a"), adjustment("adj", "a"), px("b")]);
    s.dispatch({ type: "SET_OPEN_ADJUSTMENT", payload: "adj" });
    s.dispatch({ type: "SET_ACTIVE_LAYER", payload: "adj" });
    expect(s.getState().openAdjustmentLayerId).toBe("adj");
    s.dispatch({ type: "SET_ACTIVE_LAYER", payload: "b" });
    expect(s.getState().activeLayerId).toBe("b");
    expect(s.getState().openAdjustmentLayerId).toBeNull();
  });

  it("TOGGLE_LAYER_VISIBILITY cascades from a container to its descendants", () => {
    const s = storeWithLayers([px("a"), px("b"), group("inner", ["b"]), group("g", ["a", "inner"]), px("c")]);
    s.dispatch({ type: "TOGGLE_LAYER_VISIBILITY", payload: "g" });
    for (const id of ["g", "inner", "a", "b"]) expect(layer(s, id).visible).toBe(false);
    expect(layer(s, "c").visible).toBe(true);
    s.dispatch({ type: "TOGGLE_LAYER_VISIBILITY", payload: "b" });
    expect(layer(s, "b").visible).toBe(true);
    expect(layer(s, "a").visible).toBe(false);
  });

  it("TOGGLE_LAYER_LOCK cascades, skips masks, and is blocked under a locked composite", () => {
    const s = storeWithLayers([px("a"), mask("m", "a"), composite("c", ["a"])]);
    s.dispatch({ type: "TOGGLE_LAYER_LOCK", payload: "m" });
    expect("locked" in layer(s, "m")).toBe(false);
    s.dispatch({ type: "TOGGLE_LAYER_LOCK", payload: "c" });
    expect((layer(s, "c") as CompositeLayerState).locked).toBe(true);
    expect((layer(s, "a") as PixelLayerState).locked).toBe(true);
    // A child can't unlock itself while the composite is locked.
    const st = s.getState();
    s.dispatch({ type: "TOGGLE_LAYER_LOCK", payload: "a" });
    expect(s.getState()).toBe(st);
    s.dispatch({ type: "TOGGLE_LAYER_LOCK", payload: "c" });
    expect((layer(s, "a") as PixelLayerState).locked).toBe(false);
  });

  it("opacity / blend / rename / colour space target one layer", () => {
    const s = storeWithLayers([px("a"), px("b"), group("g", [])]);
    s.dispatch({ type: "SET_LAYER_OPACITY", payload: { id: "a", opacity: 0.25 } });
    s.dispatch({ type: "SET_LAYER_BLEND", payload: { id: "a", blendMode: "multiply" } });
    s.dispatch({ type: "RENAME_LAYER", payload: { id: "b", name: "Bee" } });
    s.dispatch({ type: "SET_LAYER_COLOR_SPACE", payload: { id: "a", colorSpace: "srgb" } as never });
    s.dispatch({ type: "SET_LAYER_COLOR_SPACE", payload: { id: "g", colorSpace: "srgb" } as never });
    expect(layer(s, "a")).toMatchObject({ opacity: 0.25, blendMode: "multiply", colorSpace: "srgb" });
    expect(layer(s, "b")).toMatchObject({ name: "Bee", opacity: 1 });
    // Colour-space tags apply to pixel layers only.
    expect("colorSpace" in layer(s, "g")).toBe(false);
  });

  it("REFRESH_LINKED_LAYER bumps the nonce of linked layers only", () => {
    const linked = { ...px("l"), type: "linked", refreshNonce: 4 } as unknown as LinkedLayerState;
    const s = storeWithLayers([px("a"), linked]);
    s.dispatch({ type: "REFRESH_LINKED_LAYER", payload: "l" });
    s.dispatch({ type: "REFRESH_LINKED_LAYER", payload: "a" });
    expect((layer(s, "l") as LinkedLayerState).refreshNonce).toBe(5);
    expect("refreshNonce" in layer(s, "a")).toBe(false);
  });

  it("REORDER_LAYERS accepts a new order but rejects edits inside a locked composite", () => {
    const s = storeWithLayers([px("a"), px("b"), px("c"), composite("lc", ["a", "b"], { locked: true })]);
    const st = s.getState();
    s.dispatch({
      type: "REORDER_LAYERS",
      payload: [px("a"), px("b"), px("c"), composite("lc", ["b", "a"], { locked: true })],
    });
    expect(s.getState()).toBe(st);
    s.dispatch({
      type: "REORDER_LAYERS",
      payload: [px("a"), px("b"), px("c"), composite("lc", ["a", "b", "c"], { locked: true })],
    });
    expect(s.getState()).toBe(st);
    s.dispatch({
      type: "REORDER_LAYERS",
      payload: [px("c"), px("a"), px("b"), composite("lc", ["a", "b"], { locked: true })],
    });
    expect(ids(s)).toEqual(["c", "a", "b", "lc"]);
  });

  it("ADD_MASK_LAYER goes right above its parent; blocked on a locked composite", () => {
    const s = storeWithLayers([px("a"), px("b")]);
    s.dispatch({ type: "ADD_MASK_LAYER", payload: mask("m", "a") });
    expect(ids(s)).toEqual(["a", "m", "b"]);
    expect(s.getState().activeLayerId).toBe("m");
    const st = s.getState();
    s.dispatch({ type: "ADD_MASK_LAYER", payload: mask("m2", "missing") });
    expect(s.getState()).toBe(st);

    const locked = storeWithLayers([px("a"), composite("c", ["a"], { locked: true })]);
    const lst = locked.getState();
    locked.dispatch({ type: "ADD_MASK_LAYER", payload: mask("m", "c") });
    locked.dispatch({ type: "ADD_MASK_LAYER", payload: mask("m", "a") });
    expect(locked.getState()).toBe(lst);
  });

  it("GROUP_LAYERS / UNGROUP_LAYERS are blocked inside a locked composite", () => {
    const s = storeWithLayers([px("a"), px("b"), px("x"), group("g", ["x"]), composite("c", ["a", "b", "g"], { locked: true })]);
    const st = s.getState();
    s.dispatch({ type: "GROUP_LAYERS", payload: { groupId: "ng", groupName: "G", layerIds: ["a", "b"] } });
    expect(s.getState()).toBe(st);
    s.dispatch({ type: "UNGROUP_LAYERS", payload: { groupId: "g" } });
    expect(s.getState()).toBe(st);
  });

  it("attachments of a layer in a locked composite can't be added, reordered or removed", () => {
    const s = storeWithLayers([
      px("a"),
      mask("m", "a"),
      adjustment("x", "a"),
      adjustment("y", "a"),
      composite("c", ["a"], { locked: true }),
    ]);
    const st = s.getState();
    s.dispatch({ type: "ADD_ADJUSTMENT_LAYER", payload: adjustment("z", "a") });
    s.dispatch({ type: "ADD_ADJUSTMENT_LAYER", payload: adjustment("z", "c") });
    s.dispatch({ type: "REORDER_ADJUSTMENT_LAYERS", payload: { parentId: "a", orderedChildIds: ["y", "x"] } });
    s.dispatch({ type: "REMOVE_LAYER", payload: "m" });
    s.dispatch({ type: "REMOVE_LAYER", payload: "x" });
    expect(s.getState()).toBe(st);
  });

  it("ADD_ADJUSTMENT_LAYER stacks after the parent's existing attachments", () => {
    const s = storeWithLayers([px("a"), mask("m", "a"), adjustment("adj1", "a"), px("b")]);
    s.dispatch({ type: "ADD_ADJUSTMENT_LAYER", payload: adjustment("adj2", "a") });
    expect(ids(s)).toEqual(["a", "m", "adj1", "adj2", "b"]);
    expect(s.getState().activeLayerId).toBe("adj2");
  });

  it("REORDER_ADJUSTMENT_LAYERS reorders a parent's children in place", () => {
    const s = storeWithLayers([px("a"), adjustment("x", "a"), adjustment("y", "a"), px("b")]);
    s.dispatch({ type: "REORDER_ADJUSTMENT_LAYERS", payload: { parentId: "a", orderedChildIds: ["y", "x"] } });
    expect(ids(s)).toEqual(["a", "y", "x", "b"]);
    const st = s.getState();
    s.dispatch({ type: "REORDER_ADJUSTMENT_LAYERS", payload: { parentId: "zz", orderedChildIds: ["x"] } });
    expect(s.getState()).toBe(st);
  });

  it("UPDATE_ADJUSTMENT_LAYER replaces the effect layer", () => {
    const s = storeWithLayers([px("a"), adjustment("x", "a")]);
    const next = { ...adjustment("x", "a"), name: "Renamed" } as EffectLayerState;
    s.dispatch({ type: "UPDATE_ADJUSTMENT_LAYER", payload: next });
    expect(layer(s, "x")).toBe(next);
  });
});

// ─── Reducer: groups ─────────────────────────────────────────────────────────

describe("group actions", () => {
  it("ADD_LAYER_GROUP / ADD_COMPOSITE_LAYER insert empty containers", () => {
    const s = storeWithLayers([px("a"), px("b")]);
    s.dispatch({ type: "ADD_LAYER_GROUP", payload: { id: "g", name: "G", aboveLayerId: "a" } });
    s.dispatch({ type: "ADD_COMPOSITE_LAYER", payload: { id: "c", name: "C" } });
    expect(ids(s)).toEqual(["a", "g", "b", "c"]);
    expect(layer(s, "g")).toMatchObject({ type: "group", blendMode: "pass-through", childIds: [] });
    expect(layer(s, "c")).toMatchObject({ type: "composite", blendMode: "normal", childIds: [] });
    expect(s.getState().activeLayerId).toBe("c");
  });

  it("GROUP_LAYERS at the root puts the group above the topmost member", () => {
    const s = storeWithLayers([px("a"), px("b"), px("c")]);
    s.dispatch({ type: "GROUP_LAYERS", payload: { groupId: "g", groupName: "G", layerIds: ["a", "b"] } });
    expect(ids(s)).toEqual(["a", "b", "g", "c"]);
    expect(childIds(s, "g")).toEqual(["a", "b"]);
    expect(s.getState().activeLayerId).toBe("g");
    const st = s.getState();
    s.dispatch({ type: "GROUP_LAYERS", payload: { groupId: "x", groupName: "X", layerIds: [] } });
    expect(s.getState()).toBe(st);
  });

  it("GROUP_LAYERS inside a group replaces the members in the parent's childIds", () => {
    const s = storeWithLayers([px("a"), px("b"), px("c"), group("p", ["a", "b", "c"])]);
    s.dispatch({ type: "GROUP_LAYERS", payload: { groupId: "g", groupName: "G", layerIds: ["b", "c"] } });
    expect(childIds(s, "p")).toEqual(["a", "g"]);
    expect(childIds(s, "g")).toEqual(["b", "c"]);
  });

  it("UNGROUP_LAYERS restores the children into the parent at the group's position", () => {
    const s = storeWithLayers([px("x"), px("a"), px("b"), group("g", ["a", "b"]), px("y"), group("p", ["x", "g", "y"])]);
    s.dispatch({ type: "UNGROUP_LAYERS", payload: { groupId: "g" } });
    expect(ids(s)).not.toContain("g");
    expect(childIds(s, "p")).toEqual(["x", "a", "b", "y"]);
    expect(s.getState().activeLayerId).toBe("b");
  });

  it("UNGROUP_LAYERS at the root leaves the children as root layers; composites can't be ungrouped", () => {
    const s = storeWithLayers([px("a"), group("g", ["a"]), px("b"), composite("c", ["b"])]);
    s.dispatch({ type: "UNGROUP_LAYERS", payload: { groupId: "g" } });
    expect(ids(s)).toEqual(["a", "b", "c"]);
    const st = s.getState();
    s.dispatch({ type: "UNGROUP_LAYERS", payload: { groupId: "c" } });
    expect(s.getState()).toBe(st);
  });

  it("TOGGLE_GROUP_COLLAPSE flips containers only", () => {
    const s = storeWithLayers([px("a"), group("g", ["a"])]);
    s.dispatch({ type: "TOGGLE_GROUP_COLLAPSE", payload: "g" });
    s.dispatch({ type: "TOGGLE_GROUP_COLLAPSE", payload: "a" });
    expect((layer(s, "g") as GroupLayerState).collapsed).toBe(true);
    expect("collapsed" in layer(s, "a")).toBe(false);
  });

  it("MOVE_LAYER_INTO_GROUP moves between containers and clamps the index", () => {
    const s = storeWithLayers([px("a"), px("b"), px("c"), group("g1", ["a", "b"]), group("g2", ["c"])]);
    s.dispatch({ type: "MOVE_LAYER_INTO_GROUP", payload: { layerId: "a", targetGroupId: "g2", insertIndex: 99 } });
    expect(childIds(s, "g1")).toEqual(["b"]);
    expect(childIds(s, "g2")).toEqual(["c", "a"]);
    // Reorder within the same group (remove + reinsert).
    s.dispatch({ type: "MOVE_LAYER_INTO_GROUP", payload: { layerId: "a", targetGroupId: "g2", insertIndex: 0 } });
    expect(childIds(s, "g2")).toEqual(["a", "c"]);
    // Default index is the bottom (0).
    s.dispatch({ type: "MOVE_LAYER_INTO_GROUP", payload: { layerId: "b", targetGroupId: "g2" } });
    expect(childIds(s, "g2")).toEqual(["b", "a", "c"]);
  });

  it("MOVE_LAYER_INTO_GROUP is blocked into, out of and within a locked composite", () => {
    const s = storeWithLayers([px("a"), px("b"), composite("lc", ["a"], { locked: true }), group("g", [])]);
    const st = s.getState();
    s.dispatch({ type: "MOVE_LAYER_INTO_GROUP", payload: { layerId: "b", targetGroupId: "lc" } });
    s.dispatch({ type: "MOVE_LAYER_INTO_GROUP", payload: { layerId: "a", targetGroupId: "g" } });
    s.dispatch({ type: "MOVE_LAYER_OUT_OF_GROUP", payload: { layerId: "a", targetParentGroupId: null, insertIndex: 0 } });
    s.dispatch({ type: "MOVE_LAYER_OUT_OF_GROUP", payload: { layerId: "b", targetParentGroupId: "lc", insertIndex: 0 } });
    expect(s.getState()).toBe(st);
  });

  it("MOVE_LAYER_OUT_OF_GROUP to the root or another container", () => {
    const s = storeWithLayers([px("a"), px("b"), group("g", ["a", "b"]), group("h", [])]);
    s.dispatch({ type: "MOVE_LAYER_OUT_OF_GROUP", payload: { layerId: "a", targetParentGroupId: null, insertIndex: 0 } });
    expect(childIds(s, "g")).toEqual(["b"]);
    expect(ids(s)).toContain("a");
    s.dispatch({ type: "MOVE_LAYER_OUT_OF_GROUP", payload: { layerId: "b", targetParentGroupId: "h", insertIndex: -4 } });
    expect(childIds(s, "g")).toEqual([]);
    expect(childIds(s, "h")).toEqual(["b"]);
  });
});

// ─── Reducer: palette, brushes, view, animation ──────────────────────────────

describe("palette actions", () => {
  it("REMOVE_SWATCH reindexes groups and records the removed index", () => {
    const s = storeWith(
      { type: "SET_SWATCHES", payload: DEFAULT_SWATCHES.slice(0, 5) },
      {
        type: "SET_SWATCH_GROUPS",
        payload: [{ id: "g", name: "G", swatchIndices: [0, 2, 4] }],
      },
    );
    s.dispatch({ type: "REMOVE_SWATCH", payload: 2 });
    const st = s.getState();
    expect(st.swatches).toEqual([0, 1, 3, 4].map((i) => DEFAULT_SWATCHES[i]));
    expect(st.swatchGroups[0].swatchIndices).toEqual([0, 3]);
    expect(st.lastRemovedSwatchIndex).toBe(2);
    s.dispatch({ type: "CLEAR_REMOVED_SWATCH_INDEX" });
    expect(s.getState().lastRemovedSwatchIndex).toBeNull();
  });

  it("ADD_SWATCH_GROUP merges into a same-named group without duplicates", () => {
    const s = newStore();
    s.dispatch({ type: "ADD_SWATCH_GROUP", payload: { name: "Skin", swatchIndices: [1, 2] } });
    s.dispatch({ type: "ADD_SWATCH_GROUP", payload: { name: "Skin", swatchIndices: [2, 3] } });
    s.dispatch({ type: "ADD_SWATCH_GROUP", payload: { name: "Sky", swatchIndices: [9] } });
    const groups = s.getState().swatchGroups;
    expect(groups.map((g) => [g.name, g.swatchIndices])).toEqual([
      ["Skin", [1, 2, 3]],
      ["Sky", [9]],
    ]);
    expect(groups[0].id).not.toBe(groups[1].id);
  });

  it("group edits: add swatches, rename, cycle, remove", () => {
    const s = storeWith({
      type: "SET_SWATCH_GROUPS",
      payload: [
        { id: "g", name: "G", swatchIndices: [1] },
        { id: "h", name: "H", swatchIndices: [] },
      ],
    });
    s.dispatch({ type: "ADD_SWATCHES_TO_GROUP", payload: { id: "g", swatchIndices: [1, 5] } });
    s.dispatch({ type: "RENAME_SWATCH_GROUP", payload: { id: "g", name: "G2" } });
    const cycle = { enabled: true, stepsPerStep: 1, ticksPerStep: 2 };
    s.dispatch({ type: "UPDATE_SWATCH_GROUP_CYCLE", payload: { groupId: "g", cycle } });
    expect(s.getState().swatchGroups[0]).toEqual({ id: "g", name: "G2", swatchIndices: [1, 5], cycle });
    s.dispatch({ type: "REMOVE_SWATCH_GROUP", payload: "g" });
    expect(s.getState().swatchGroups.map((g) => g.id)).toEqual(["h"]);
  });

  it("colour actions and active swatch", () => {
    const s = newStore();
    const c = { r: 1, g: 2, b: 3, a: 4 };
    s.dispatch({ type: "SET_PRIMARY_COLOR", payload: c });
    s.dispatch({ type: "SET_SECONDARY_COLOR", payload: c });
    s.dispatch({ type: "ADD_SWATCH", payload: c });
    s.dispatch({ type: "SET_ACTIVE_SWATCH", payload: 3 });
    const st = s.getState();
    expect(st.primaryColor).toBe(c);
    expect(st.secondaryColor).toBe(c);
    expect(st.swatches.at(-1)).toBe(c);
    expect(st.activePaletteIndex).toBe(3);
  });
});

describe("brush actions", () => {
  const brush = (id: string): never => ({ id, name: id }) as never;

  it("paint brushes: add / update / remove clears the active id", () => {
    const s = newStore();
    s.dispatch({ type: "ADD_BRUSH", payload: brush("a") });
    s.dispatch({ type: "ADD_BRUSH", payload: brush("b") });
    s.dispatch({ type: "SET_ACTIVE_BRUSH", payload: "a" });
    const updated = { id: "b", name: "Bee" } as never;
    s.dispatch({ type: "UPDATE_BRUSH", payload: updated });
    expect(s.getState().brushes[1]).toBe(updated);
    s.dispatch({ type: "REMOVE_BRUSH", payload: "b" });
    expect(s.getState().activeBrushId).toBe("a");
    s.dispatch({ type: "REMOVE_BRUSH", payload: "a" });
    expect(s.getState().activeBrushId).toBeNull();
    expect(s.getState().brushes).toEqual([]);
    s.dispatch({ type: "SET_BRUSHES", payload: [brush("z")] });
    expect(s.getState().brushes).toHaveLength(1);
  });

  it("pixel brushes: add / rename / remove / set", () => {
    const s = newStore();
    s.dispatch({ type: "ADD_PIXEL_BRUSH", payload: brush("p") });
    s.dispatch({ type: "RENAME_PIXEL_BRUSH", payload: { id: "p", name: "Pea" } });
    expect(s.getState().pixelBrushes[0].name).toBe("Pea");
    s.dispatch({ type: "REMOVE_PIXEL_BRUSH", payload: "p" });
    expect(s.getState().pixelBrushes).toEqual([]);
    s.dispatch({ type: "SET_PIXEL_BRUSHES", payload: [brush("q")] });
    expect(s.getState().pixelBrushes).toHaveLength(1);
  });
});

describe("view actions", () => {
  it("grid, rulers and guides", () => {
    const s = newStore();
    s.dispatch({ type: "TOGGLE_GRID" });
    s.dispatch({ type: "TOGGLE_RULERS" });
    s.dispatch({ type: "TOGGLE_GUIDES" });
    s.dispatch({ type: "SET_GRID_SIZE", payload: 0 });
    s.dispatch({ type: "SET_GRID_COLOR", payload: "#fff" });
    s.dispatch({ type: "SET_GRID_TYPE", payload: "isometric" as never });
    const c = s.getState().canvas;
    expect(c).toMatchObject({ showGrid: true, showRulers: true, showGuides: false, gridSize: 1, gridColor: "#fff" });
    expect(c.gridType).toBe("isometric");

    s.dispatch({ type: "ADD_GUIDE", payload: { id: "g1", axis: "h", position: 10 } });
    s.dispatch({ type: "ADD_GUIDE", payload: { id: "g2", axis: "v", position: 20 } });
    s.dispatch({ type: "MOVE_GUIDE", payload: { id: "g1", position: 15 } });
    s.dispatch({ type: "DELETE_GUIDE", payload: "g2" });
    expect(s.getState().canvas.guides).toEqual([{ id: "g1", axis: "h", position: 15 }]);
    s.dispatch({ type: "CLEAR_GUIDES" });
    expect(s.getState().canvas.guides).toEqual([]);
  });

  it("turning tiled mode off also hides the tile grid", () => {
    const s = storeWith(
      { type: "SET_TILED_MODE", payload: true },
      { type: "SET_SHOW_TILE_GRID", payload: true },
    );
    expect(s.getState().canvas.showTileGrid).toBe(true);
    s.dispatch({ type: "SET_TILED_MODE", payload: false });
    expect(s.getState().canvas).toMatchObject({ tiledMode: false, showTileGrid: false });
  });

  it("tool, shape, open adjustment and animation mode", () => {
    const s = newStore();
    s.dispatch({ type: "SET_TOOL", payload: "eraser" });
    s.dispatch({ type: "SET_SHAPE", payload: "ellipse" as never });
    s.dispatch({ type: "SET_OPEN_ADJUSTMENT", payload: "x" });
    s.dispatch({ type: "SET_ANIMATION_MODE", payload: true });
    expect(s.getState()).toMatchObject({
      activeTool: "eraser",
      activeShape: "ellipse",
      openAdjustmentLayerId: "x",
      animationMode: true,
    });
  });
});

describe("animation actions", () => {
  it("sprite sheet, palette animation and cell animation are mutually exclusive", () => {
    const s = newStore();
    s.dispatch({ type: "SET_SPRITESHEET", payload: { enabled: true, cellWidth: 16 } });
    expect(s.getState().spritesheet).toMatchObject({ enabled: true, cellWidth: 16 });
    s.dispatch({ type: "SET_PALETTE_ANIMATION", payload: { enabled: true } });
    expect(s.getState().spritesheet.enabled).toBe(false);
    expect(s.getState().spritesheet.cellWidth).toBe(16);
    s.dispatch({ type: "SET_CELL_ANIMATION", payload: { enabled: true } });
    expect(s.getState().paletteAnimation.enabled).toBe(false);
    expect(s.getState().cellAnimation.enabled).toBe(true);
    // Disabling one leaves the others as they are.
    const before = s.getState().paletteAnimation;
    s.dispatch({ type: "SET_SPRITESHEET", payload: { enabled: false } });
    expect(s.getState().cellAnimation.enabled).toBe(true);
    expect(s.getState().paletteAnimation).toBe(before);
  });

  it("animations and frames", () => {
    const s = newStore();
    const anim = (id: string): never =>
      ({ id, name: id, fps: 8, playbackMode: "loop", frames: [] }) as never;
    s.dispatch({ type: "ADD_ANIMATION", payload: anim("a") });
    s.dispatch({ type: "ADD_ANIMATION", payload: anim("b") });
    expect(s.getState().spritesheet.selectedAnimationId).toBe("b");

    s.dispatch({ type: "ADD_FRAME", payload: { animationId: "b", frame: { id: "f1", duration: 1 } } });
    s.dispatch({ type: "ADD_FRAME", payload: { animationId: "b", frame: { id: "f2", duration: 1 } } });
    s.dispatch({ type: "UPDATE_FRAME", payload: { animationId: "b", frame: { id: "f1", duration: 3 } } });
    s.dispatch({ type: "SET_SELECTED_FRAME", payload: "f2" });
    s.dispatch({ type: "DELETE_FRAME", payload: { animationId: "b", frameId: "f2" } });
    let ss = s.getState().spritesheet;
    expect(ss.animations[1].frames).toEqual([{ id: "f1", duration: 3 }]);
    expect(ss.selectedFrameId).toBeNull();

    s.dispatch({ type: "UPDATE_ANIMATION", payload: { ...(anim("a") as object), fps: 24 } as never });
    expect(s.getState().spritesheet.animations[0].fps).toBe(24);

    s.dispatch({ type: "SET_SELECTED_FRAME", payload: "f1" });
    s.dispatch({ type: "DELETE_ANIMATION", payload: "b" });
    ss = s.getState().spritesheet;
    expect(ss.animations.map((a) => a.id)).toEqual(["a"]);
    // Deleting the selected animation selects the first remaining one.
    expect(ss.selectedAnimationId).toBe("a");
    expect(ss.selectedFrameId).toBeNull();
    s.dispatch({ type: "DELETE_ANIMATION", payload: "a" });
    expect(s.getState().spritesheet.selectedAnimationId).toBeNull();

    s.dispatch({ type: "SET_SELECTED_FRAME", payload: "zz" });
    s.dispatch({ type: "SET_SELECTED_ANIMATION", payload: "q" });
    expect(s.getState().spritesheet).toMatchObject({ selectedAnimationId: "q", selectedFrameId: null });
  });
});
