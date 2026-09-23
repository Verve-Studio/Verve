# 057 · Heavy WASM work freezes the UI thread

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | WASM |
| Verified | No — reported by reviewer |

## Problem
Only `exportDds.ts` uses a Worker. Everything else runs on the main thread:
- `inpaintRegion` (PatchMatch over a full-canvas pyramid, 10 EM iterations)
- grabcut
- `matchPaletteIndices` (`pixelops.cpp:248`): up to 255 distance checks per pixel, called on every indexed merge, transform and colour-mode conversion
- quantize (a full sort on every split)

## Where
- `src/wasm/index.ts`
- `wasm/src/pixelops.cpp:248`

## Suggested fix
Run a second pixelops instance in a Worker with transferable buffers for the long-running ops (inpaint, grabcut, quantize). Add a colour→index cache (hash map) to `matchPaletteIndices`.

## Done when
- The UI stays responsive (spinner animates, cancel works) during Content-Aware Fill on a 4K document.


## Resolution
A new persistent worker (`src/wasm/pixelopsWorker.ts` + `pixelopsWorkerClient.ts`) runs a second pixelops instance for the long operations: Content-Aware Fill inpainting, palette quantize (Reduce Colors, Generate Palette) and the all-WASM GrabCut fallback. The worker is started on first use and terminated after 60 s idle (releasing its WASM heap); a crashed worker is replaced on the next request. `matchPaletteIndices` (C++) now has a 64K-entry direct-mapped colour cache plus a same-as-previous-pixel fast path; a 200k-pixel test matched brute force exactly. WASM rebuilt. Still on the main thread: the GPU-hybrid GrabCut's small WASM steps (k-means, GMM update, mincut).
