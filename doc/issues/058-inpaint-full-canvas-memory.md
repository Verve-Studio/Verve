# 058 · Inpaint processes the whole canvas and the WASM heap never shrinks

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance / Memory |
| Area | WASM / Inpaint |
| Verified | No — reported by reviewer |

## Problem
Level 0 copies all pixels, masks and n-sized `dist` / `nearestSource` / `fillIndex` int vectors (~20+ bytes/pixel) regardless of fill size. On an 8k² document one fill grows the WASM heap by > 1.3 GB, which stays allocated.

## Where
- `wasm/src/inpaint.cpp:164, 258-270`

## Suggested fix
Crop in JS to the fill bbox plus a search margin before the call, then paste back. Running inpaint in a Worker instance that can be torn down (see [057](057-wasm-main-thread.md)) also releases the memory.

## Done when
- Filling a small region of an 8K document grows the heap proportionally to the region, not the canvas.


## Resolution
`inpaintRegion` (used by Content-Aware Fill and the other inpaint callers) now runs on a crop instead of the whole canvas, and pastes the result back into a copy of the input.
- **With a source mask:** the crop is fill ∪ source-mask bbox, which gives an identical result because patches can only come from the source mask.
- **Without one:** fill bbox ± max(256 px, 2× the fill size) of context. This can change results only when the best patch lay further away than that.

WASM heap growth now scales with the fill region instead of the canvas.
