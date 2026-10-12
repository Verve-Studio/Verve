// Real-module heap growth: a pinned (heap-resident) view must survive
// `memory.grow` and still be usable by the wrappers that read it in place.
// Kept in its own file: the grown heap stays allocated for the worker's life.
import { describe, expect, it } from "vitest";
import {
  allocWasmU8,
  floodFillInPlace,
  freeWasm,
  getPixelOps,
  matchPaletteIndices,
  resizeLayer,
} from "@/wasm";

describe("WASM heap growth", () => {
  it("re-binds pinned views when the wrapped _malloc grows memory", async () => {
    const m = await getPixelOps();
    let pinned: Uint8Array | null = null;
    const alloc = allocWasmU8(m, 4 * 4, (v) => (pinned = v));
    expect(alloc).not.toBeNull();
    pinned = alloc!.view;
    pinned.set([10, 10, 10, 255, 250, 250, 250, 255, 200, 0, 0, 255, 0, 0, 0, 0]);
    const original = pinned;
    const bufferBefore = m.HEAPU8.buffer;

    // Larger than the whole current heap: memory.grow must run.
    const big = m._malloc(m.HEAPU8.length);
    try {
      expect(m.HEAPU8.buffer).not.toBe(bufferBefore);
      // The old view is detached; the refreshed one sits on the new buffer
      // at the same address with the same bytes.
      expect(original.byteLength).toBe(0);
      expect(pinned!.buffer).toBe(m.HEAPU8.buffer);
      expect(pinned!.byteOffset).toBe(alloc!.ptr);
      expect(Array.from(pinned!)).toEqual([
        10, 10, 10, 255, 250, 250, 250, 255, 200, 0, 0, 255, 0, 0, 0, 0,
      ]);

      // Wrappers read a heap-resident input in place.
      const palette = [
        { r: 0, g: 0, b: 0, a: 255 },
        { r: 255, g: 255, b: 255, a: 255 },
        { r: 255, g: 0, b: 0, a: 255 },
      ];
      expect(Array.from(await matchPaletteIndices(pinned!, palette))).toEqual([0, 1, 2, 255]);
      const resized = await resizeLayer(
        { data: pinned!, format: "rgba8", width: 2, height: 2, offsetX: 0, offsetY: 0 },
        2, 2, 1, 1, { x: 0, y: 0, width: 2, height: 2 }, "nearest",
      );
      expect(Array.from(resized)).toEqual(Array.from(pinned!));

      // In-place kernels write through the pinned pointer.
      expect(floodFillInPlace(alloc!.ptr, "rgba8", 2, 2, 0, 0, 1, 2, 3, 4)).toBe(true);
      expect(Array.from(pinned!.subarray(0, 4))).toEqual([1, 2, 3, 4]);
      expect(Array.from(pinned!.subarray(4, 8))).toEqual([250, 250, 250, 255]);
    } finally {
      m._free(big);
      freeWasm(m, alloc!.ptr);
    }
  });
});
