# 096 · Dead WASM exports and unused C++ filters

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Maintenance |
| Area | WASM |
| Verified | No — reported by reviewer |

## Problem
The `floodFillIndexed` WASM export has no callers (Fill uses a TS version), and most of `filters.cpp` isn't exported. This adds build time, binary size and maintenance cost.

## Where
- `wasm/src/pixelops.cpp`, `wasm/src/filters.cpp`, `wasm/CMakeLists.txt`

## Suggested fix
Either switch indexed Fill to the WASM export (faster, and consistent with [017](017-fill-async-race-stale-layer.md)) or remove it; delete unexported filter code.

## Done when
- Every WASM export has a caller; unused C++ is removed.


## Resolution
Removed the three uncalled exports (pixelops_convolve, pixelops_dither_bayer, floodFillIndexed) from pixelops.cpp, CMake EXPORTED_FUNCTIONS, src/wasm/index.ts (wrappers + wrapPtrFn lines) and src/wasm/types.ts. filters.cpp/.h and dither.cpp/.h had no other callers (every GPU effect replaced them) and were deleted from the tree and the CMake source list. Indexed Fill keeps its TS flood fill (tied into 017's generation token). WASM rebuilt; typecheck passes.
