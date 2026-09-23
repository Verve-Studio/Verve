# 033 · Pinned `layer.data` views go stale after heap growth inside C++

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Stability |
| Area | WASM boundary |
| Verified | No — reported by reviewer |

## Problem
`syncIfGrew` only runs inside the JS `_malloc` wrapper. Inpaint, grabcut, `loadExr`/`saveExr` and quantize allocate large `std::vector`s internally; when those grow memory, every pinned `layer.data` view stays detached until a later JS `_malloc`. E.g. `useContentAwareFill.ts` calls `captureHistory()` right after `inpaintRegion`: reads of detached arrays throw, indexed writes are silently dropped.

## Where
- `src/wasm/index.ts:93-106` (`wrapPtrFn`), `:118-122`

## Suggested fix
Call `syncIfGrew(m)` after every exported call in `wrapPtrFn` (one identity compare of `HEAPU8.buffer`).

## Done when
- Content-Aware Fill on a large document that forces heap growth is immediately followed by a correct history capture and further painting works.


## Resolution
wrapPtrFn (src/wasm/index.ts) calls syncIfGrew(wrappedModule) after every wrapped export, so heap growth inside C++ (std::vector in inpaint/grabcut/EXR/quantize) re-binds pinned layer.data views immediately. (Implemented with 034; status corrected later.)
