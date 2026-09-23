# 003 · EXR decode truncates pointers to int32

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Stability |
| Area | WASM / File I/O |
| Verified | Partially — struct layout confirmed; runtime failure reported by reviewer |

## Problem
`ExrLayerOut.namePtr/pixelsPtr` and `ExrMultiResult.layersPtr` are declared `int` and filled with `(int)(uintptr_t)ptr`. `loadExr`'s `float* pixels` is also read with `getInt32`. The heap starts at 512 MB and pinned layers live in it, so heaps > 2 GB are normal on big documents. Past that, pointers go negative: JS reads garbage and `freeExrLayersResult` frees a sign-extended bogus address, aborting the module.

## Where
- `wasm/src/exr.cpp:49-63`, `:234-239`
- `src/wasm/index.ts:909`, `:992-1000`

## Suggested fix
Change pointer fields to `uint64_t`, update the `static_assert` sizes/offsets, and read them in JS with `getBigUint64` → `Number(...)`. Audit every other C++ result struct returned to JS for the same `int` pointer pattern. Fix together with [002](002-exr-export-empty-files.md).

## Done when
- Opening multi-layer EXRs works when the WASM heap is > 2 GB (e.g. after loading a large document).


## Resolution
Fixed together with 002: `ExrResult.pixels`, `ExrLayerOut.namePtr/pixelsPtr` and `ExrMultiResult.layersPtr` are `uint64_t` (ExrLayerOut stride 24 → 32, layersPtr at +16), read with `getBigUint64`. Verified multi-layer decode in the Node round-trip.
