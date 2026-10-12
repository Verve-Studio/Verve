import { describe, expect, it, vi } from "vitest";
import { TransformStore, type TransformEnterData } from "@/core/store/transformStore";

function enterData(): TransformEnterData {
  return {
    layerId: "layer-1",
    previousTool: "brush",
    isSelectionMode: true,
    originalW: 10,
    originalH: 20,
    originalRect: { x: 1, y: 2, w: 10, h: 20 },
    floatBuffer: new Float32Array(10 * 20 * 4),
    pixelFormat: "rgba32f",
    floatCanvas: {} as OffscreenCanvas,
    savedLayerPixels: new Float32Array(4),
    savedSelectionMask: new Uint8Array(1),
    params: {
      x: 1,
      y: 2,
      w: 10,
      h: 20,
      rotation: 0,
      pivotX: 6,
      pivotY: 12,
      shearX: 0,
      shearY: 0,
      perspectiveCorners: null,
    },
  };
}

describe("TransformStore", () => {
  it("enter loads the session and resets per-session UI options", () => {
    const t = new TransformStore();
    t.aspectLocked = true;
    t.handleMode = "rotate" as typeof t.handleMode;
    t.interpolation = "nearest" as typeof t.interpolation;
    const fn = vi.fn();
    t.subscribe(fn);
    const data = enterData();
    t.enter(data);
    t.unsubscribe(fn);
    expect(t.isActive).toBe(true);
    expect(t.layerId).toBe("layer-1");
    expect(t.previousTool).toBe("brush");
    expect(t.isSelectionMode).toBe(true);
    expect(t.pixelFormat).toBe("rgba32f");
    expect(t.floatBuffer).toBe(data.floatBuffer);
    expect(t.params).toBe(data.params);
    expect(t.aspectLocked).toBe(false);
    expect(t.handleMode).toBe("scale");
    expect(t.interpolation).toBe("bilinear");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("updateParams merges into a fresh params object", () => {
    const t = new TransformStore();
    t.enter(enterData());
    const before = t.params;
    t.updateParams({ rotation: 45, x: 7 });
    expect(t.params).not.toBe(before);
    expect(t.params).toMatchObject({ rotation: 45, x: 7, y: 2, w: 10 });
    expect(before.rotation).toBe(0);
  });

  it("clear drops buffers and handlers", () => {
    const t = new TransformStore();
    t.enter(enterData());
    t.onApply = vi.fn();
    t.onCancel = vi.fn();
    t.clear();
    expect(t.isActive).toBe(false);
    expect(t.layerId).toBe("");
    expect(t.floatBuffer).toBeNull();
    expect(t.floatCanvas).toBeNull();
    expect(t.savedLayerPixels).toBeNull();
    expect(t.savedSelectionMask).toBeNull();
    expect(t.onApply).toBeNull();
    expect(t.onCancel).toBeNull();
  });

  it("triggerApply / triggerCancel call the registered handlers", () => {
    const t = new TransformStore();
    expect(() => {
      t.triggerApply();
      t.triggerCancel();
    }).not.toThrow();
    const apply = vi.fn();
    const cancel = vi.fn();
    t.onApply = apply;
    t.onCancel = cancel;
    t.triggerApply();
    t.triggerCancel();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
