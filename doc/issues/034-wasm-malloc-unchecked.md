# 034 · WASM `_malloc` results are never checked; an OOM corrupts memory

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Stability |
| Area | WASM boundary |
| Verified | No — reported by reviewer |

## Problem
With `ALLOW_MEMORY_GROWTH`, Emscripten defaults to `ABORTING_MALLOC=0`, so an out-of-memory `_malloc` returns 0. `HEAPU8.set(data, 0)` then overwrites low memory (static data and stack), causing silent heap corruption. `wasmHeapStorage.ts` checks for 0; the wrappers in `index.ts` don't. A C++ `bad_alloc` aborts the module for good, and `getPixelOps` keeps returning the dead cached instance.

## Where
- `src/wasm/index.ts:215` (`withInPlaceBuffer`) and every other wrapper

## Suggested fix
Add a `mallocOrThrow(size)` helper that frees allocations made so far and throws a `MemoryLimitError`. Detect the aborted module state (`ABORT` flag / caught `RuntimeError`) and re-instantiate the module on next use, re-pinning layers.

## Done when
- A WASM allocation failure surfaces as a user-visible out-of-memory error; the app keeps working afterwards.


## Resolution
The `_malloc` wrapper in `src/wasm/index.ts` now throws `WasmOutOfMemoryError` (clear message) when the allocation fails, which covers every caller (index.ts, brushStamp, lcms2). The pinning paths in `wasmHeapStorage` (`mallocOrZero`) and the brush-bitmap bake keep their graceful fallback. `wrapPtrFn` detects a module abort (`WebAssembly.RuntimeError`) and tells the user once to save and restart. Transparent re-instantiation was not done: pinned layers live in the dead module's heap, so freeing them through a new instance would corrupt it.
