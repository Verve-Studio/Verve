# 069 · Reduce Colors panel does a full readback + quantize on every slider tick

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | Effects / ReduceColors |
| Verified | No — reported by reviewer |

## Problem
Every `colorCount` change triggers a full-resolution readback, a JS conversion loop over the whole image and a WASM quantize, with no debounce. `genRef` only discards stale results; the work still piles up.

## Where
- `src/core/effects/ReduceColors/ReduceColorsPanel.tsx:33-81`

## Suggested fix
Debounce 150–250 ms (or run on commit), and quantize a downsampled copy (palette generation doesn't need every pixel).

## Done when
- Dragging the colour-count slider on a 4K image stays smooth.


## Resolution
The Reduce Colors panel now waits 200 ms after the last slider change (a pending run is cancelled by the next change), then quantizes an even subsample of at most 1M pixels instead of every pixel. rgba32f input is gamma-encoded with `linearToSrgbChannel` before quantizing (the old `v*255` conversion violated the transfer-function rule; see 074).
