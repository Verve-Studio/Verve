import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import type { LayerState } from "@/types";
import type { AppAction } from "@/core/store/AppContext";
import { useLayerArrange } from "@/core/services/useLayerArrange";
import { ids, liveStateRef, mask, pixel, renderHookWithAppStore, seedLayers } from "@tests/fakes/uxAppStore";
import { fakeGpuLayer, handleRef, makeFakeCanvasHandle } from "@tests/fakes/uxFakeCanvasHandle";

afterEach(cleanup);

type Gpu = ReturnType<typeof fakeGpuLayer>;
let gpu: Map<string, Gpu>;
let invalidate: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  gpu = new Map();
  invalidate = vi.fn<() => void>();
});

/** An rgba8 layer `w`×`h` at (ox, oy) whose opaque pixels span the given
 *  layer-local rect (inclusive). */
function opaqueRect(id: string, w: number, h: number, ox: number, oy: number, rect = { x0: 0, y0: 0, x1: w - 1, y1: h - 1 }): Gpu {
  const data = new Uint8Array(w * h * 4);
  for (let y = rect.y0; y <= rect.y1; y++) for (let x = rect.x0; x <= rect.x1; x++) data[(y * w + x) * 4 + 3] = 255;
  const g = fakeGpuLayer(id, "rgba8", w, h, ox, oy, data);
  gpu.set(id, g);
  return g;
}

function setup(layers: LayerState[], extra: AppAction[] = []) {
  const fake = makeFakeCanvasHandle({ invalidate });
  fake.getGpuLayer.mockImplementation((id) => gpu.get(id) ?? null);
  const captureHistory = vi.fn();
  const h = renderHookWithAppStore(
    (store) =>
      useLayerArrange({
        canvasHandleRef: handleRef(fake.handle),
        stateRef: liveStateRef(store),
        captureHistory,
        dispatch: store.dispatch,
      }),
    [...seedLayers(layers, null), ...extra],
  );
  const offsets = (id: string) => [gpu.get(id)!.offsetX, gpu.get(id)!.offsetY];
  return { ...h, captureHistory, offsets, state: () => h.store.getState() };
}

describe("useLayerArrange.handleAlign", () => {
  const three = () => {
    opaqueRect("a", 10, 10, 0, 0); // bbox 0..9, 0..9
    opaqueRect("b", 10, 10, 20, 30); // bbox 20..29, 30..39
    // Only the centre 2×2 is opaque: bbox 45..46, 15..16
    opaqueRect("c", 10, 10, 41, 11, { x0: 4, y0: 4, x1: 5, y1: 5 });
    return setup([pixel("a"), pixel("b"), pixel("c")]);
  };

  it("left aligns the opaque bounds, not the layer rects", () => {
    const { result, offsets, captureHistory } = three();
    act(() => result.current.handleAlign("left"));
    expect(offsets("a")).toEqual([0, 0]);
    expect(offsets("b")).toEqual([0, 30]);
    expect(offsets("c")).toEqual([-4, 11]);
    expect(invalidate).toHaveBeenCalled();
    expect(captureHistory).toHaveBeenCalledWith("Align Layers");
  });

  it("right / bottom align to the outermost edge", () => {
    const { result, offsets } = three();
    act(() => result.current.handleAlign("right"));
    expect(offsets("a")).toEqual([37, 0]); // r 9 → 46
    expect(offsets("b")).toEqual([37, 30]);
    expect(offsets("c")).toEqual([41, 11]);
    act(() => result.current.handleAlign("bottom"));
    expect(offsets("a")[1]).toBe(30); // b 9 → 39
    expect(offsets("c")[1]).toBe(34); // b 16 → 39
  });

  it("centre alignment uses the midpoint of the combined bounds", () => {
    const { result, offsets } = three();
    act(() => result.current.handleAlign("centerV"));
    // combined x 0..46 → 23; a centre round(4.5)=5 → +18
    expect(offsets("a")[0]).toBe(18);
    act(() => result.current.handleAlign("centerH"));
    // combined y 0..39 → round(19.5)=20; b centre round(34.5)=35 → -15
    expect(offsets("b")[1]).toBe(15);
  });

  it("only aligns the selected + active layers when there is a selection", () => {
    opaqueRect("a", 4, 4, 0, 0);
    opaqueRect("b", 4, 4, 10, 0);
    opaqueRect("c", 4, 4, 20, 0);
    const { result, offsets } = setup([pixel("a"), pixel("b"), pixel("c")], [
      { type: "SET_ACTIVE_LAYER", payload: "c" },
      { type: "SET_SELECTED_LAYERS", payload: ["b"] },
    ]);
    act(() => result.current.handleAlign("left"));
    expect(offsets("a")).toEqual([0, 0]);
    expect(offsets("b")).toEqual([10, 0]);
    expect(offsets("c")).toEqual([10, 0]);
  });

  it("skips transparent layers and needs two layers with content", () => {
    opaqueRect("a", 4, 4, 5, 5);
    gpu.set("empty", fakeGpuLayer("empty", "rgba8", 4, 4, 0, 0));
    const { result, offsets, captureHistory } = setup([pixel("a"), pixel("empty")]);
    act(() => result.current.handleAlign("left"));
    expect(offsets("a")).toEqual([5, 5]);
    expect(captureHistory).not.toHaveBeenCalled();
  });

  it("reads bounds from float alpha and indexed transparency", () => {
    const f = new Float32Array(4 * 4 * 4);
    f[(1 * 4 + 2) * 4 + 3] = 0.5; // pixel (2,1)
    gpu.set("f", fakeGpuLayer("f", "rgba32f", 4, 4, 0, 0, f));
    const idx = new Uint8Array(16).fill(255);
    idx[3 * 4 + 3] = 7; // pixel (3,3)
    gpu.set("i", fakeGpuLayer("i", "indexed8", 4, 4, 10, 10, idx));
    const { result, offsets } = setup([pixel("f"), pixel("i")]);
    act(() => result.current.handleAlign("top"));
    // f top = 1, i top = 13 → i moves up 12
    expect(offsets("i")).toEqual([10, -2]);
    expect(offsets("f")).toEqual([0, 0]);
  });
});

describe("useLayerArrange.handleDistribute", () => {
  it("spaces the inner layers' centres evenly between the outer two", () => {
    opaqueRect("a", 2, 2, 0, 0); // centre 0.5
    opaqueRect("b", 2, 2, 3, 0); // centre 3.5
    opaqueRect("c", 2, 2, 30, 0); // centre 30.5
    const { result, offsets, captureHistory } = setup([pixel("c"), pixel("a"), pixel("b")]);
    act(() => result.current.handleDistribute("horizontal"));
    expect(offsets("a")).toEqual([0, 0]);
    expect(offsets("b")).toEqual([15, 0]);
    expect(offsets("c")).toEqual([30, 0]);
    expect(captureHistory).toHaveBeenCalledWith("Distribute Layers");
  });

  it("needs at least three layers", () => {
    opaqueRect("a", 2, 2, 0, 0);
    opaqueRect("b", 2, 2, 0, 9);
    const { result, captureHistory } = setup([pixel("a"), pixel("b")]);
    act(() => result.current.handleDistribute("vertical"));
    expect(captureHistory).not.toHaveBeenCalled();
  });
});

describe("useLayerArrange.handleOrder", () => {
  const stack = () => [pixel("a"), mask("am", "a"), pixel("b"), pixel("c"), pixel("d")];

  it.each([
    ["front", ["b"], ["a", "am", "c", "d", "b"]],
    ["back", ["c"], ["c", "a", "am", "b", "d"]],
    ["forward", ["a"], ["b", "a", "am", "c", "d"]],
    ["backward", ["d"], ["a", "am", "b", "d", "c"]],
    ["forward", ["a", "b"], ["c", "a", "am", "b", "d"]],
    ["backward", ["a", "c"], ["a", "am", "c", "b", "d"]],
    ["reverse", ["a", "c", "d"], ["d", "b", "c", "a", "am"]],
  ] as const)("%s %j", (op, sel, expected) => {
    const { result, state, captureHistory } = setup(stack());
    act(() => result.current.handleOrder(op, sel));
    expect(ids(state().layers)).toEqual(expected);
    expect(captureHistory).toHaveBeenCalledWith("Reorder Layers");
  });

  it("the top layer can't move further forward", () => {
    const { result, state } = setup(stack());
    act(() => result.current.handleOrder("forward", ["d"]));
    expect(ids(state().layers)).toEqual(["a", "am", "b", "c", "d"]);
  });

  it("ignores ids that aren't root layers", () => {
    const { result, state, captureHistory } = setup(stack());
    act(() => result.current.handleOrder("front", ["nope"]));
    expect(ids(state().layers)).toEqual(["a", "am", "b", "c", "d"]);
    expect(captureHistory).not.toHaveBeenCalled();
  });
});
