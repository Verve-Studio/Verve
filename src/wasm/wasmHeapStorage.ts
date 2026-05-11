/**
 * WASM-heap-resident typed-array storage with growth-aware view refresh.
 *
 * Background: typed arrays constructed as `new Uint8Array(module.HEAPU8.buffer,
 * ptr, len)` share memory with the WASM kernel — zero-copy reads/writes from
 * both sides. But when the WASM linear memory grows (any `_malloc` may
 * trigger it), the underlying ArrayBuffer is *replaced*. All previously
 * constructed views become detached and any read/write throws. So we have
 * to track every WASM-backed view we've handed out and recreate them after
 * each growth.
 *
 * Design:
 *   * `allocWasmU8(module, length)` allocates `_malloc(length)` bytes and
 *     returns a `{ ptr, view, refresh }` triple. The caller stores the
 *     `view` as their typed-array reference and is responsible for
 *     re-reading it after `refresh()` (typically because they exposed a
 *     "data" field on some object).
 *   * `syncIfGrew(module)` checks whether the heap was replaced since the
 *     last sync. If yes, it walks the registry and asks every allocation
 *     to refresh its view. Cheap when no growth happened (one === compare).
 *     Call this at WASM-call boundaries — i.e. before reading any
 *     WASM-backed view from JS.
 *   * `freeWasm(module, ptr)` frees and unregisters.
 *
 * Lifetime: the registry holds strong references to each allocation's
 * refresh closure; freeWasm removes it. A consumer that forgets to free
 * will leak the closure (and the underlying WASM pages). Use in
 * conjunction with explicit destroy hooks (renderer.destroyLayer, etc.).
 */
import { memoryStore } from "@/core/store/memoryStore";
import type { PixelOpsModule } from "./types";

interface WasmAlloc {
  ptr: number;
  byteLength: number;
  kind: "u8" | "f32";
  /** Called after a heap growth — receives a fresh typed-array view that
   *  the caller must store wherever it referenced the old view. */
  onRefresh: (newView: Uint8Array | Float32Array) => void;
}

const REGISTRY: Map<number, WasmAlloc> = new Map();
// `ArrayBufferLike` covers both ArrayBuffer and SharedArrayBuffer (Emscripten
// can be configured for either). We only care about identity, so the wider
// type is fine.
let lastBufferSeen: ArrayBufferLike | null = null;

function makeView(
  module: PixelOpsModule,
  alloc: WasmAlloc,
): Uint8Array | Float32Array {
  if (alloc.kind === "u8") {
    return new Uint8Array(module.HEAPU8.buffer, alloc.ptr, alloc.byteLength);
  }
  return new Float32Array(
    module.HEAPU8.buffer,
    alloc.ptr,
    alloc.byteLength / 4,
  );
}

/**
 * If the WASM heap has been replaced since the last call, recreate every
 * registered view and notify the owners. No-op when the heap is unchanged
 * — costs a single buffer-identity compare. Safe to call at the entry of
 * every WASM operation that runs from JS.
 */
export function syncIfGrew(module: PixelOpsModule): void {
  const buf = module.HEAPU8.buffer;
  if (buf === lastBufferSeen) return;
  lastBufferSeen = buf;
  for (const alloc of REGISTRY.values()) {
    alloc.onRefresh(makeView(module, alloc));
  }
}

/**
 * Allocate `length` bytes in the WASM heap and hand back a Uint8Array
 * view + a pointer. Returns `null` if the allocation can't be made —
 * either `_malloc` returned 0 (out of memory, hit the wasm64 16 GB cap,
 * etc.) OR the request would push the tracked CPU bucket past the
 * user's configured buffer-memory cap. Caller should fall back.
 *
 * WASM linear memory is system RAM — the same physical bucket as
 * JS-side typed arrays — so it counts toward `memoryStore`'s CPU
 * total. Without this, pinning a layer (which copies its JS-heap
 * buffer into the WASM heap then drops the JS reference) would make
 * the tracked CPU total *decrease* by the layer's size when the JS
 * array is GC'd, even though actual RAM use is unchanged.
 */
export function allocWasmU8(
  module: PixelOpsModule,
  length: number,
  onRefresh: (newView: Uint8Array) => void,
): { ptr: number; view: Uint8Array } | null {
  if (length <= 0) return null;
  syncIfGrew(module);
  // Reserve against the CPU cap first. `tryAlloc` returns false when
  // the request would exceed the user's budget (and Max Out is off);
  // caller falls back rather than throw.
  if (!memoryStore.tryAlloc("cpu", length)) return null;
  const ptr = module._malloc(length);
  if (ptr === 0) {
    memoryStore.release("cpu", length);
    return null;
  }
  // _malloc may have grown; resync so the view we make is on the new buffer.
  syncIfGrew(module);
  const alloc: WasmAlloc = {
    ptr,
    byteLength: length,
    kind: "u8",
    onRefresh: onRefresh as (v: Uint8Array | Float32Array) => void,
  };
  REGISTRY.set(ptr, alloc);
  const view = new Uint8Array(module.HEAPU8.buffer, ptr, length);
  return { ptr, view };
}

/** Float32 variant — `length` is in *floats*, not bytes. */
export function allocWasmF32(
  module: PixelOpsModule,
  length: number,
  onRefresh: (newView: Float32Array) => void,
): { ptr: number; view: Float32Array } | null {
  if (length <= 0) return null;
  syncIfGrew(module);
  const byteLength = length * 4;
  if (!memoryStore.tryAlloc("cpu", byteLength)) return null;
  const ptr = module._malloc(byteLength);
  if (ptr === 0) {
    memoryStore.release("cpu", byteLength);
    return null;
  }
  syncIfGrew(module);
  const alloc: WasmAlloc = {
    ptr,
    byteLength,
    kind: "f32",
    onRefresh: onRefresh as (v: Uint8Array | Float32Array) => void,
  };
  REGISTRY.set(ptr, alloc);
  const view = new Float32Array(module.HEAPU8.buffer, ptr, length);
  return { ptr, view };
}

export function freeWasm(module: PixelOpsModule, ptr: number): void {
  if (ptr === 0) return;
  const alloc = REGISTRY.get(ptr);
  if (alloc) {
    memoryStore.release("cpu", alloc.byteLength);
    REGISTRY.delete(ptr);
  }
  module._free(ptr);
}
