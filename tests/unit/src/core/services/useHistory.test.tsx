import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { useState } from "react";
import { useAppSelector, type AppStore } from "@/core/store/AppContext";
import { activeScope, createDocumentScope, setActiveScope } from "@/core/store/scope";
import type { TiledLayerSnapshot } from "@/core/store/tiledSnapshot";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { TabRecord } from "@/core/store/tabTypes";
import { useHistory } from "@/core/services/useHistory";
import { useLayers } from "@/core/services/useLayers";
import { ids, liveStateRef, pixel, renderHookWithAppStore, seedLayers } from "@tests/fakes/uxAppStore";
import { makeFakeCanvasHandle } from "@tests/fakes/uxFakeCanvasHandle";

vi.mock("@/wasm", () => ({ matchPaletteIndices: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * A canvas whose layers mirror the store's layer list. Each layer's pixels
 * are one immutable tile; `paint(id)` swaps in a new tile, like a stroke.
 */
function historyCanvas(store: () => AppStore) {
  const tiles = new Map<string, Uint8Array>();
  const tileOf = (id: string): Uint8Array => {
    let t = tiles.get(id);
    if (!t) tiles.set(id, (t = new Uint8Array(4)));
    return t;
  };
  const layerIds = () => store().getState().layers.map((l) => l.id);
  const snapshot = (tile: Uint8Array): TiledLayerSnapshot => ({
    width: 1,
    height: 1,
    channels: 4,
    float: false,
    tilesX: 1,
    tilesY: 1,
    tiles: [tile],
  });
  const restoreAllLayerPixels = vi.fn<CanvasHandle["restoreAllLayerPixels"]>((data) => {
    for (const [id, snap] of data) tiles.set(id, snap.tiles[0] as Uint8Array);
  });
  const fake = makeFakeCanvasHandle({
    borrowAllLayerPixels: () => new Map(layerIds().map((id) => [id, tileOf(id)])),
    captureAllLayerGeometry: () =>
      new Map(layerIds().map((id) => [id, { layerWidth: 1, layerHeight: 1, offsetX: 0, offsetY: 0 }])),
    captureAllAdjustmentMasks: () => new Map(),
    captureAllLayerSnapshots: () => new Map(layerIds().map((id) => [id, snapshot(tileOf(id))])),
    restoreAllLayerPixels,
    restoreAllAdjustmentMasks: vi.fn(),
  });
  const paint = (id: string, value: number): void => {
    tiles.set(id, new Uint8Array(4).fill(value));
  };
  const pixelValue = (id: string): number => tileOf(id)[0];
  return { handle: fake.handle, paint, pixelValue, restoreAllLayerPixels };
}

function setup(layerIds = ["a"]) {
  let storeRef: AppStore | null = null;
  const canvas = historyCanvas(() => storeRef!);
  const setPendingLayerData = vi.fn();
  const h = renderHookWithAppStore(
    (store) => {
      storeRef = store;
      const [refs] = useState(() => ({
        stateRef: liveStateRef(store),
        canvasHandleRef: { current: canvas.handle },
        activeTabIdRef: { current: "t1" },
        setTabsRef: { current: vi.fn() as unknown as React.Dispatch<React.SetStateAction<TabRecord[]>> },
      }));
      const layers = useAppSelector((s) => s.layers);
      const history = useHistory({
        ...refs,
        dispatch: store.dispatch,
        setPendingLayerData,
        layers,
        subscribe: store.subscribe,
      });
      const layerOps = useLayers({
        canvasHandleRef: refs.canvasHandleRef,
        stateRef: refs.stateRef,
        dispatch: store.dispatch,
        pendingLayerLabelRef: history.pendingLayerLabelRef,
      });
      return { history, layers: layerOps.commands };
    },
    seedLayers(layerIds.map((id) => pixel(id)), layerIds[0]),
  );
  const hist = () => activeScope().history;
  const labels = () => hist().entries.map((e) => e.label);
  return { ...h, ...canvas, hist, labels, state: () => h.store.getState() };
}

beforeEach(() => {
  setActiveScope(createDocumentScope());
});

describe("useHistory", () => {
  it("records the initial state once the canvas is ready", () => {
    const { result, labels } = setup();
    act(() => result.current.history.captureReadyHistory());
    expect(labels()).toEqual(["Initial State"]);
    // A later remount of the same document records nothing.
    act(() => result.current.history.captureReadyHistory());
    expect(labels()).toEqual(["Initial State"]);
  });

  it("labels the capture after a remount with the pending operation", () => {
    const { result, labels } = setup();
    act(() => result.current.history.captureReadyHistory());
    result.current.history.pendingRemountLabelRef.current = "Resize Canvas";
    act(() => result.current.history.captureReadyHistory());
    // Nothing changed in this fake, so the capture is a de-duplicated no-op…
    expect(labels()).toEqual(["Initial State"]);
    // …and the label is consumed.
    expect(result.current.history.pendingRemountLabelRef.current).toBeNull();
  });

  it("captures pixel edits and drops captures identical to the current entry", () => {
    const { result, labels, paint } = setup();
    act(() => result.current.history.captureReadyHistory());
    act(() => result.current.history.captureHistory("Nothing"));
    expect(labels()).toEqual(["Initial State"]);
    paint("a", 9);
    act(() => result.current.history.captureHistory("Brush"));
    expect(labels()).toEqual(["Initial State", "Brush"]);
  });

  it("records a layer command once the layer list commits, under its label", () => {
    const { result, labels } = setup();
    act(() => result.current.history.captureReadyHistory());
    act(() => {
      result.current.layers.newLayer();
    });
    expect(labels()).toEqual(["Initial State", "New Layer"]);
    act(() => result.current.layers.addMask("a"));
    expect(labels()).toEqual(["Initial State", "New Layer", "Add Layer Mask"]);
  });

  it("undo / redo restore pixels and the layer stack without recording", () => {
    const { result, labels, hist, paint, pixelValue, state, restoreAllLayerPixels } = setup();
    act(() => result.current.history.captureReadyHistory());
    paint("a", 7);
    act(() => result.current.history.captureHistory("Brush"));
    let newId = "";
    act(() => {
      newId = result.current.layers.newLayer();
    });
    expect(ids(state().layers)).toEqual(["a", newId]);

    act(() => hist().undo());
    expect(ids(state().layers)).toEqual(["a"]);
    expect(pixelValue("a")).toBe(7);
    act(() => hist().undo());
    expect(pixelValue("a")).toBe(0);
    expect(restoreAllLayerPixels).toHaveBeenCalledTimes(2);
    expect(labels()).toEqual(["Initial State", "Brush", "New Layer"]);
    expect(hist().currentIndex).toBe(0);

    act(() => hist().redo());
    act(() => hist().redo());
    expect(ids(state().layers)).toEqual(["a", newId]);
    expect(pixelValue("a")).toBe(7);
    expect(labels()).toHaveLength(3);
  });

  it("an edit after undo truncates the redo chain", () => {
    const { result, labels, hist, paint } = setup();
    act(() => result.current.history.captureReadyHistory());
    paint("a", 1);
    act(() => result.current.history.captureHistory("One"));
    act(() => hist().undo());
    paint("a", 2);
    act(() => result.current.history.captureHistory("Two"));
    expect(labels()).toEqual(["Initial State", "Two"]);
  });

  it("records unlabelled document edits after they settle (safety net)", () => {
    vi.useFakeTimers();
    const { result, labels, store } = setup();
    act(() => result.current.history.captureReadyHistory());
    act(() => {
      store.dispatch({ type: "SET_LAYER_OPACITY", payload: { id: "a", opacity: 0.5 } });
      store.dispatch({ type: "SET_LAYER_OPACITY", payload: { id: "a", opacity: 0.4 } });
    });
    expect(labels()).toEqual(["Initial State"]);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(labels()).toEqual(["Initial State", "Edit a"]);
  });

  it("UI-only changes (active layer, group collapse) are not recorded", () => {
    vi.useFakeTimers();
    const { result, labels, store } = setup(["a", "b"]);
    act(() => result.current.history.captureReadyHistory());
    act(() => {
      store.dispatch({ type: "SET_ACTIVE_LAYER", payload: "b" });
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(labels()).toEqual(["Initial State"]);
  });

  it("undo first records a pending unlabelled edit, so it can be undone", () => {
    vi.useFakeTimers();
    const { result, labels, store, hist, state } = setup();
    act(() => result.current.history.captureReadyHistory());
    act(() => {
      store.dispatch({ type: "RENAME_LAYER", payload: { id: "a", name: "Sky" } });
    });
    act(() => hist().undo());
    expect(labels()).toEqual(["Initial State", "Edit Sky"]);
    expect(state().layers[0].name).toBe("a");
  });

  it("records nothing while the canvas holds no layers", () => {
    const { result, labels } = setup([]);
    act(() => result.current.history.captureHistory("X"));
    expect(labels()).toEqual([]);
  });
});
