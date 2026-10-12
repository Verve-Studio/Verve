import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { activeScope, createDocumentScope } from "@/core/store/scope";
import type { TabRecord, TabSnapshot } from "@/core/store/tabTypes";
import type { LayerState } from "@/types";
import { displayStore } from "@/ux/main/Canvas/displayStore";
import { useTabs } from "@/core/services/useTabs";
import { ids, pixel, renderHookWithAppStore, seedLayers } from "@tests/fakes/uxAppStore";
import { fakeGpuLayer, makeFakeCanvasHandle } from "@tests/fakes/uxFakeCanvasHandle";

afterEach(cleanup);
beforeEach(() => {
  displayStore.setEV(0);
});

function tab(id: string, layers: LayerState[], extra: Partial<TabRecord> = {}): TabRecord {
  return {
    id,
    title: id,
    filePath: null,
    snapshot: {
      canvasWidth: 64,
      canvasHeight: 32,
      backgroundFill: "white",
      layers,
      activeLayerId: layers[0]?.id ?? null,
      zoom: 2,
      pixelFormat: "rgba8",
    } as TabSnapshot,
    savedLayerData: null,
    scope: createDocumentScope(),
    canvasKey: 0,
    tiledMode: false,
    showTileGrid: false,
    pixelFormat: "rgba8",
    exposureEV: 0,
    toneMappingOperator: "clamp",
    viewTransformLutId: null,
    ...extra,
  } as TabRecord;
}

function setup() {
  const h = renderHookWithAppStore((store) => useTabs(store.getState, store.dispatch));
  const open = (tabs: TabRecord[], activeId: string) =>
    act(() => {
      h.result.current.setTabs(tabs);
      h.result.current.switchToTab(activeId, tabs);
    });
  return { ...h, open, state: () => h.store.getState() };
}

describe("useTabs", () => {
  it("switchToTab activates the tab's scope and loads its document into the store", () => {
    const t1 = tab("t1", [pixel("a")], { exposureEV: 1.5 });
    const { result, open, state } = setup();
    open([t1], "t1");
    expect(result.current.activeTabId).toBe("t1");
    expect(result.current.activeTabIdRef.current).toBe("t1");
    expect(activeScope()).toBe(t1.scope);
    expect(ids(state().layers)).toEqual(["a"]);
    expect(state().canvas).toMatchObject({ width: 64, height: 32, zoom: 2 });
    expect(displayStore.exposureEV).toBe(1.5);
  });

  it("canvasHandleRef always points at the active tab's canvas", () => {
    const { result, open } = setup();
    const h1 = makeFakeCanvasHandle().handle;
    const h2 = makeFakeCanvasHandle().handle;
    act(() => {
      result.current.tabCanvasRef("t1")(h1);
      result.current.tabCanvasRef("t2")(h2);
    });
    expect(result.current.tabCanvasRef("t1")).toBe(result.current.tabCanvasRef("t1"));
    const tabs = [tab("t1", [pixel("a")]), tab("t2", [pixel("b")])];
    open(tabs, "t1");
    expect(result.current.canvasHandleRef.current).toBe(h1);
    act(() => result.current.switchToTab("t2", tabs));
    expect(result.current.canvasHandleRef.current).toBe(h2);
    act(() => result.current.tabCanvasRef("t2")(null));
    expect(result.current.canvasHandleRef.current).toBeNull();
  });

  it("handleSwitchTab stashes the outgoing tab's snapshot and a copy of its pixels", () => {
    const { result, open, state } = setup();
    const data = new Uint8Array([1, 2, 3, 4]);
    const fake = makeFakeCanvasHandle();
    fake.getGpuLayer.mockImplementation((id) => (id === "a" ? fakeGpuLayer("a", "rgba8", 1, 1, 5, 6, data) : null));
    act(() => result.current.tabCanvasRef("t1")(fake.handle));
    open([tab("t1", [pixel("a")]), tab("t2", [pixel("b")])], "t1");
    act(() => {
      result.current.handleSwitchTab("t2");
    });
    expect(result.current.activeTabId).toBe("t2");
    expect(ids(state().layers)).toEqual(["b"]);
    const t1 = result.current.tabs.find((t) => t.id === "t1")!;
    expect(ids(t1.snapshot.layers)).toEqual(["a"]);
    const saved = t1.savedLayerData!.layers.get("a")!;
    expect(saved.geo).toEqual({ layerWidth: 1, layerHeight: 1, offsetX: 5, offsetY: 6 });
    expect(Array.from(saved.data)).toEqual([1, 2, 3, 4]);
    // A copy: later writes to the live buffer don't reach the stash.
    expect(saved.data).not.toBe(data);
  });

  it("switching to the active tab is a no-op", () => {
    const { result, open } = setup();
    open([tab("t1", [pixel("a")])], "t1");
    const before = result.current.tabs;
    act(() => result.current.handleSwitchTab("t1"));
    expect(result.current.tabs).toBe(before);
  });

  it("serializeActiveTabPixels returns null without a canvas or pixel layers", () => {
    const { result, open } = setup();
    open([tab("t1", [pixel("a")])], "t1");
    expect(result.current.serializeActiveTabPixels()).toBeNull();
    act(() => result.current.tabCanvasRef("t1")(makeFakeCanvasHandle().handle));
    expect(result.current.serializeActiveTabPixels()).toBeNull();
  });

  it("closing the active tab activates the next one (or the last) and disposes its history", () => {
    const { result, open } = setup();
    const tabs = [tab("t1", [pixel("a")]), tab("t2", [pixel("b")]), tab("t3", [pixel("c")])];
    const dispose = vi.spyOn(tabs[1].scope.history, "dispose");
    open(tabs, "t2");
    act(() => result.current.handleCloseTab("t2"));
    expect(result.current.tabs.map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(result.current.activeTabId).toBe("t3");
    expect(dispose).toHaveBeenCalled();
    act(() => result.current.handleCloseTab("t3"));
    expect(result.current.activeTabId).toBe("t1");
  });

  it("closeTabs closes several tabs in one update", () => {
    const { result, open } = setup();
    open([tab("t1", [pixel("a")]), tab("t2", [pixel("b")]), tab("t3", [pixel("c")])], "t1");
    act(() => result.current.closeTabs(["t1", "t2"]));
    expect(result.current.tabs.map((t) => t.id)).toEqual(["t3"]);
    expect(result.current.activeTabId).toBe("t3");
  });

  it("closing a background tab keeps the active one", () => {
    const { result, open, state } = setup();
    open([tab("t1", [pixel("a")]), tab("t2", [pixel("b")])], "t1");
    act(() => result.current.closeTabs(["t2", "unknown"]));
    expect(result.current.activeTabId).toBe("t1");
    expect(ids(state().layers)).toEqual(["a"]);
  });

  it("releaseMountedLayerData drops the active tab's pixel hand-off", () => {
    const { result, open } = setup();
    const bundle = { layers: new Map(), adjustmentMasks: new Map() };
    open([tab("t1", [pixel("a")], { savedLayerData: bundle }), tab("t2", [pixel("b")], { savedLayerData: bundle })], "t1");
    act(() => result.current.setPendingLayerData(bundle));
    act(() => result.current.releaseMountedLayerData());
    expect(result.current.pendingLayerData).toBeNull();
    expect(result.current.tabs.find((t) => t.id === "t1")!.savedLayerData).toBeNull();
    expect(result.current.tabs.find((t) => t.id === "t2")!.savedLayerData).toBe(bundle);
  });
});

// Seed helper kept for parity with the other hook tests (unused layers in the
// bootstrap state must not leak into a switched-to tab).
describe("useTabs with a pre-populated store", () => {
  it("switchToTab replaces whatever the store held", () => {
    const h = renderHookWithAppStore((store) => useTabs(store.getState, store.dispatch), seedLayers([pixel("old")], "old"));
    const t = tab("t1", [pixel("new")]);
    act(() => {
      h.result.current.setTabs([t]);
      h.result.current.switchToTab("t1", [t]);
    });
    expect(ids(h.store.getState().layers)).toEqual(["new"]);
    expect(h.store.getState().selectedLayerIds).toEqual([]);
  });
});
