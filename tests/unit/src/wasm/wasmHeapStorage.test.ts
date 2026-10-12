// wasmHeapStorage: heap-resident typed-array views and their re-binding
// after WASM memory growth. Uses a small fake module so growth can be
// simulated deterministically; wasmHeapGrowth.test.ts covers the real module.
import { describe, expect, it, vi } from "vitest";
import { allocWasmF32, allocWasmU8, freeWasm, syncIfGrew } from "@/wasm/wasmHeapStorage";
import type { PixelOpsModule } from "@/wasm/types";
import { memoryStore } from "@/core/store/memoryStore";
import { preferencesStore } from "@/core/store/preferencesStore";

/** A bump-allocating stand-in for the Emscripten module: `grow()` replaces
 *  the heap buffer (copying its contents), as memory.grow does. */
function fakeModule(bytes = 4096) {
  let next = 16;
  const freed: number[] = [];
  const m = {
    HEAPU8: new Uint8Array(bytes),
    HEAPF32: new Float32Array(0),
    _malloc(size: number): number {
      const ptr = next;
      next += (size + 7) & ~7;
      if (next > m.HEAPU8.length) return 0;
      return ptr;
    },
    _free(ptr: number): void {
      freed.push(ptr);
    },
    grow(): void {
      const bigger = new Uint8Array(m.HEAPU8.length * 2);
      bigger.set(m.HEAPU8);
      m.HEAPU8 = bigger;
      m.HEAPF32 = new Float32Array(bigger.buffer);
    },
    freed,
  };
  m.HEAPF32 = new Float32Array(m.HEAPU8.buffer);
  return m;
}
const asModule = (m: ReturnType<typeof fakeModule>) => m as unknown as PixelOpsModule;

describe("wasmHeapStorage", () => {
  it("allocates a view on the heap that shares memory with it", () => {
    const m = fakeModule();
    const a = allocWasmU8(asModule(m), 10, () => {})!;
    try {
      expect(a.view.buffer).toBe(m.HEAPU8.buffer);
      expect(a.view.byteOffset).toBe(a.ptr);
      expect(a.view.length).toBe(10);
      a.view[3] = 42;
      expect(m.HEAPU8[a.ptr + 3]).toBe(42);
    } finally {
      freeWasm(asModule(m), a.ptr);
    }
  });

  it("re-binds every registered view after the heap is replaced, keeping contents", () => {
    const m = fakeModule();
    const mod = asModule(m);
    let u8: Uint8Array | null = null;
    let f32: Float32Array | null = null;
    const a = allocWasmU8(mod, 8, (v) => (u8 = v))!;
    const b = allocWasmF32(mod, 3, (v) => (f32 = v))!;
    try {
      a.view.set([1, 2, 3, 4, 5, 6, 7, 8]);
      b.view.set([1.5, -2, 1000]);
      syncIfGrew(mod); // no growth yet: still the original views
      m.grow();
      syncIfGrew(mod);
      expect(u8).not.toBeNull();
      expect(f32).not.toBeNull();
      expect(u8!.buffer).toBe(m.HEAPU8.buffer);
      expect(Array.from(u8!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(f32!.buffer).toBe(m.HEAPU8.buffer);
      expect(f32!.byteOffset).toBe(b.ptr);
      expect(Array.from(f32!)).toEqual([1.5, -2, 1000]);
    } finally {
      freeWasm(mod, a.ptr);
      freeWasm(mod, b.ptr);
    }
  });

  it("does not call refresh callbacks when nothing grew", () => {
    const m = fakeModule();
    const mod = asModule(m);
    const onRefresh = vi.fn();
    const a = allocWasmU8(mod, 4, onRefresh)!;
    try {
      syncIfGrew(mod);
      syncIfGrew(mod);
      expect(onRefresh).not.toHaveBeenCalled();
    } finally {
      freeWasm(mod, a.ptr);
    }
  });

  it("freed allocations are no longer refreshed and release their tracked bytes", () => {
    const m = fakeModule();
    const mod = asModule(m);
    const before = memoryStore.getCpu();
    const onRefresh = vi.fn();
    const a = allocWasmF32(mod, 4, onRefresh)!;
    expect(memoryStore.getCpu()).toBe(before + 16);
    freeWasm(mod, a.ptr);
    expect(memoryStore.getCpu()).toBe(before);
    expect(m.freed).toContain(a.ptr);
    m.grow();
    syncIfGrew(mod);
    expect(onRefresh).not.toHaveBeenCalled();
    // ptr 0 is ignored.
    freeWasm(mod, 0);
    expect(m.freed).not.toContain(0);
  });

  it("returns null (and reserves nothing) for empty, failed or over-budget allocations", () => {
    const m = fakeModule(64);
    const mod = asModule(m);
    const before = memoryStore.getCpu();
    expect(allocWasmU8(mod, 0, () => {})).toBeNull();
    expect(allocWasmF32(mod, -1, () => {})).toBeNull();
    // Heap exhausted: _malloc returns 0.
    expect(allocWasmU8(mod, 1000, () => {})).toBeNull();
    expect(memoryStore.getCpu()).toBe(before);

    // Over the user's buffer-memory cap: refused before touching the heap.
    const malloc = vi.spyOn(m, "_malloc");
    vi.spyOn(preferencesStore, "get").mockReturnValue({
      ...preferencesStore.get(),
      bufferMemoryMaxOut: false,
      unifiedMemory: false,
      bufferMemoryBytes: before + 8,
    });
    expect(allocWasmU8(mod, 16, () => {})).toBeNull();
    expect(malloc).not.toHaveBeenCalled();
    expect(memoryStore.getCpu()).toBe(before);
  });

  it("treats a throwing _malloc (WasmOutOfMemoryError) as a failed pin", () => {
    const m = fakeModule();
    const mod = asModule(m);
    const before = memoryStore.getCpu();
    vi.spyOn(m, "_malloc").mockImplementation(() => {
      throw new Error("out of memory");
    });
    expect(allocWasmU8(mod, 32, () => {})).toBeNull();
    expect(memoryStore.getCpu()).toBe(before);
  });
});
