import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { AppState, LayerState } from "@/types";
import type { LayerDataBundle } from "@/core/store/layerPayload";
import type { TabRecord } from "@/core/store/tabTypes";
import { activeScope } from "@/core/store/scope";
import { useCanvasTransforms } from "@/core/services/useCanvasTransforms";
import {
  fakeGpuLayer,
  handleRef,
  makeFakeCanvasHandle,
  type FakeCanvasHandle,
} from "@tests/fakes/uxFakeCanvasHandle";
import { pixel } from "@tests/fakes/uxAppStore";

// rgba8 / indexed8 rotate & flip run in WASM; these tests use rgba32f layers
// (pure JS path) and only check that 8-bit layers are routed to WASM.
const wasm = vi.hoisted(() => ({
  rotateRgba: vi.fn(async (d: Uint8Array) => d),
  rotateIndexed: vi.fn(async (d: Uint8Array) => d),
  flipRgba: vi.fn(async (d: Uint8Array) => d),
  flipIndexed: vi.fn(async (d: Uint8Array) => d),
}));
vi.mock("@/wasm", () => wasm);

afterEach(cleanup);

let fake: FakeCanvasHandle;
let alertSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fake = makeFakeCanvasHandle();
  alertSpy = vi.fn();
  vi.stubGlobal("alert", alertSpy);
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const f of Object.values(wasm)) f.mockClear();
});

function setup(opts: { width: number; height: number; layers?: LayerState[]; noHandle?: boolean }) {
  const layers = opts.layers ?? [pixel("a")];
  const stateRef = { current: { layers } as unknown as AppState };
  const dispatch = vi.fn();
  let tabs = [{ id: "t1", canvasKey: 3, snapshot: { canvasWidth: opts.width, canvasHeight: opts.height } }] as unknown as TabRecord[];
  const setTabs = vi.fn((u: TabRecord[] | ((p: TabRecord[]) => TabRecord[])) => {
    tabs = typeof u === "function" ? u(tabs) : u;
  });
  const setPendingLayerData = vi.fn();
  const pendingRemountLabelRef = { current: null as string | null };
  const { result } = renderHook(() =>
    useCanvasTransforms({
      canvasHandleRef: handleRef(opts.noHandle ? null : fake.handle),
      stateRef,
      captureHistory: vi.fn(),
      dispatch,
      activeTabId: "t1",
      activeTabIdRef: { current: "t1" },
      setTabs,
      setPendingLayerData,
      pendingRemountLabelRef,
      canvasWidth: opts.width,
      canvasHeight: opts.height,
    }),
  );
  const pending = (): LayerDataBundle => setPendingLayerData.mock.calls.at(-1)![0];
  const geo = (id = "a") => pending().layers.get(id)!.geo;
  const tab = () => tabs[0] as unknown as { canvasKey: number; snapshot: { canvasWidth: number; canvasHeight: number } };
  return { result, dispatch, setPendingLayerData, pendingRemountLabelRef, pending, geo, tab };
}

/** A float layer whose pixel i has red = i + 1. */
function numbered(w: number, h: number): Float32Array {
  const d = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = i + 1;
    d[i * 4 + 3] = 1;
  }
  return d;
}
const reds = (d: Uint8Array | Float32Array): number[] =>
  Array.from({ length: d.length / 4 }, (_, i) => d[i * 4]);

describe("useCanvasTransforms.handleResizeCanvas", () => {
  it.each([
    [0, 0, 0, 0],
    [1, 1, 2, 1],
    [2, 2, 4, 2],
    [2, 0, 4, 0],
  ] as const)("anchor (%d,%d) offsets a full-canvas layer by (%d,%d) when growing 4×4 → 8×6", (col, row, ox, oy) => {
    fake.getGpuLayer.mockReturnValue(fakeGpuLayer("a", "rgba32f", 4, 4));
    const { result, dispatch, geo, tab, pendingRemountLabelRef } = setup({ width: 4, height: 4 });
    act(() => result.current.handleResizeCanvas({ width: 8, height: 6, anchorCol: col, anchorRow: row }));
    expect(geo()).toEqual({ layerWidth: 4, layerHeight: 4, offsetX: ox, offsetY: oy });
    expect(dispatch).toHaveBeenCalledWith({ type: "RESIZE_CANVAS", payload: { width: 8, height: 6 } });
    expect(tab().canvasKey).toBe(4);
    expect(tab().snapshot).toMatchObject({ canvasWidth: 8, canvasHeight: 6 });
    expect(pendingRemountLabelRef.current).toBe("Resize Canvas");
  });

  it("shrinking around the centre clips the layer to the new canvas, keeping the middle pixels", () => {
    fake.getGpuLayer.mockReturnValue(fakeGpuLayer("a", "rgba32f", 4, 4, 0, 0, numbered(4, 4)));
    const { result, geo, pending } = setup({ width: 4, height: 4 });
    act(() => result.current.handleResizeCanvas({ width: 2, height: 2, anchorCol: 1, anchorRow: 1 }));
    expect(geo()).toEqual({ layerWidth: 2, layerHeight: 2, offsetX: 0, offsetY: 0 });
    expect(reds(pending().layers.get("a")!.data)).toEqual([6, 7, 10, 11]);
  });

  it("does nothing for the same size, and throws without a canvas when asked to", () => {
    const same = setup({ width: 4, height: 4 });
    act(() => same.result.current.handleResizeCanvas({ width: 4, height: 4, anchorCol: 1, anchorRow: 1 }));
    expect(same.dispatch).not.toHaveBeenCalled();
    const none = setup({ width: 4, height: 4, noHandle: true });
    expect(() =>
      none.result.current.handleResizeCanvas({ width: 5, height: 4, anchorCol: 1, anchorRow: 1 }, { throwErrors: true }),
    ).toThrow(/isn't ready/);
  });

  it("carries baked adjustment masks as canvas-sized rgba8", () => {
    const adj = { id: "fx", type: "adjustment", parentId: "a", hasMask: true } as unknown as LayerState;
    fake.getGpuLayer.mockImplementation((id) => (id === "a" ? fakeGpuLayer("a", "rgba32f", 2, 2) : null));
    fake.getAdjustmentMaskPixels.mockReturnValue(new Uint8Array(2 * 2 * 4).fill(255));
    const { result, pending } = setup({ width: 2, height: 2, layers: [pixel("a"), adj] });
    act(() => result.current.handleResizeCanvas({ width: 3, height: 2, anchorCol: 0, anchorRow: 0 }));
    const m = pending().adjustmentMasks.get("fx")!;
    expect(m).toHaveLength(3 * 2 * 4);
    // Column 2 is new canvas: transparent.
    expect(Array.from(m.subarray(8, 12))).toEqual([0, 0, 0, 0]);
    expect(Array.from(m.subarray(0, 4))).toEqual([255, 255, 255, 255]);
  });
});

describe("useCanvasTransforms.handleCrop", () => {
  it("crops to the rect clamped to the canvas", () => {
    fake.getGpuLayer.mockReturnValue(fakeGpuLayer("a", "rgba32f", 4, 4, 0, 0, numbered(4, 4)));
    const clear = vi.spyOn(activeScope().crop, "clear");
    const { result, dispatch, geo, pending, pendingRemountLabelRef } = setup({ width: 4, height: 4 });
    act(() => result.current.handleCrop({ x: 2, y: -3, w: 10, h: 4 }));
    // x 2..4, y 0..1 (the part of y -3..1 inside the canvas)
    expect(dispatch).toHaveBeenCalledWith({ type: "RESIZE_CANVAS", payload: { width: 2, height: 4 } });
    expect(geo()).toEqual({ layerWidth: 2, layerHeight: 4, offsetX: 0, offsetY: 0 });
    expect(reds(pending().layers.get("a")!.data)).toEqual([3, 4, 7, 8, 11, 12, 15, 16]);
    expect(pendingRemountLabelRef.current).toBe("Crop");
    expect(clear).toHaveBeenCalled();
  });

  it("rejects a missing or out-of-canvas rect when asked to throw, otherwise does nothing", () => {
    const { result, dispatch } = setup({ width: 4, height: 4 });
    activeScope().crop.clear();
    expect(() => result.current.handleCrop(undefined, { throwErrors: true })).toThrow(/No crop rectangle/);
    expect(() => result.current.handleCrop({ x: 10, y: 0, w: 2, h: 2 }, { throwErrors: true })).toThrow(
      /outside the canvas/,
    );
    act(() => result.current.handleCrop({ x: 10, y: 0, w: 2, h: 2 }));
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("useCanvasTransforms.handleRotate / handleFlip", () => {
  it("90° CW rotates float pixels, remaps the layer offset and swaps the canvas size", async () => {
    // 4×3 canvas; a 2×1 layer at (1,2) holding [1, 2].
    fake.getGpuLayer.mockReturnValue(fakeGpuLayer("a", "rgba32f", 2, 1, 1, 2, numbered(2, 1)));
    const { result, dispatch, geo, pending, tab, pendingRemountLabelRef } = setup({ width: 4, height: 3 });
    await act(() => result.current.handleRotate("90cw"));
    // (x, y) → (H-1-y, x): pixel (1,2) → (0,1), (2,2) → (0,2).
    expect(geo()).toEqual({ layerWidth: 1, layerHeight: 2, offsetX: 0, offsetY: 1 });
    expect(reds(pending().layers.get("a")!.data)).toEqual([1, 2]);
    expect(dispatch).toHaveBeenCalledWith({ type: "RESIZE_CANVAS", payload: { width: 3, height: 4 } });
    expect(tab().snapshot).toMatchObject({ canvasWidth: 3, canvasHeight: 4 });
    expect(pendingRemountLabelRef.current).toBe("Rotate 90° CW");
  });

  it("270° CW is the inverse mapping", async () => {
    fake.getGpuLayer.mockReturnValue(fakeGpuLayer("a", "rgba32f", 2, 1, 1, 2, numbered(2, 1)));
    const { result, geo, pending } = setup({ width: 4, height: 3 });
    await act(() => result.current.handleRotate("270cw"));
    // (x, y) → (y, W-1-x): (1,2) → (2,2), (2,2) → (2,1)
    expect(geo()).toEqual({ layerWidth: 1, layerHeight: 2, offsetX: 2, offsetY: 1 });
    expect(reds(pending().layers.get("a")!.data)).toEqual([2, 1]);
  });

  it("180° keeps the canvas size (no RESIZE_CANVAS) and reverses the pixels", async () => {
    fake.getGpuLayer.mockReturnValue(fakeGpuLayer("a", "rgba32f", 2, 2, 0, 0, numbered(2, 2)));
    const { result, dispatch, geo, pending, pendingRemountLabelRef } = setup({ width: 4, height: 4 });
    await act(() => result.current.handleRotate("180"));
    expect(geo()).toEqual({ layerWidth: 2, layerHeight: 2, offsetX: 2, offsetY: 2 });
    expect(reds(pending().layers.get("a")!.data)).toEqual([4, 3, 2, 1]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(pendingRemountLabelRef.current).toBe("Rotate 180°");
  });

  it("flips mirror the pixels and the offset", async () => {
    fake.getGpuLayer.mockReturnValue(fakeGpuLayer("a", "rgba32f", 2, 2, 1, 0, numbered(2, 2)));
    const h = setup({ width: 4, height: 3 });
    await act(() => h.result.current.handleFlip("horizontal"));
    expect(h.geo()).toEqual({ layerWidth: 2, layerHeight: 2, offsetX: 1, offsetY: 0 });
    expect(reds(h.pending().layers.get("a")!.data)).toEqual([2, 1, 4, 3]);
    expect(h.pendingRemountLabelRef.current).toBe("Flip Horizontal");
    expect(h.tab().canvasKey).toBe(4);

    await act(() => h.result.current.handleFlip("vertical"));
    expect(h.geo()).toEqual({ layerWidth: 2, layerHeight: 2, offsetX: 1, offsetY: 1 });
    expect(reds(h.pending().layers.get("a")!.data)).toEqual([3, 4, 1, 2]);
  });

  it("routes 8-bit and indexed layers to the WASM kernels", async () => {
    fake.getGpuLayer.mockImplementation((id) =>
      id === "a" ? fakeGpuLayer("a", "rgba8", 2, 2) : fakeGpuLayer("b", "indexed8", 2, 2),
    );
    const { result } = setup({ width: 2, height: 2, layers: [pixel("a"), pixel("b")] });
    await act(() => result.current.handleRotate("90cw"));
    expect(wasm.rotateRgba).toHaveBeenCalledWith(expect.any(Uint8Array), 2, 2, 0);
    expect(wasm.rotateIndexed).toHaveBeenCalledWith(expect.any(Uint8Array), 2, 2, 0);
    await act(() => result.current.handleFlip("vertical"));
    expect(wasm.flipRgba).toHaveBeenCalledWith(expect.any(Uint8Array), 2, 2, 1);
  });

  it("reports failures, or rethrows them for automation", async () => {
    fake.getGpuLayer.mockReturnValue(fakeGpuLayer("a", "rgba8", 2, 2));
    wasm.rotateRgba.mockRejectedValueOnce(new Error("out of memory")).mockRejectedValueOnce(new Error("out of memory"));
    const { result } = setup({ width: 2, height: 2 });
    await act(() => result.current.handleRotate("90cw"));
    expect(String(alertSpy.mock.calls[0][0])).toBe("Rotate failed.\n\nout of memory");
    await expect(result.current.handleRotate("90cw", { throwErrors: true })).rejects.toThrow("out of memory");
  });
});
