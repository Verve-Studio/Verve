# 064 · Blur/Sharpen/Smudge/Liquify ignore the selection, allocate per stamp, skip stroke brackets

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Correctness / Performance |
| Area | Tools / localBrush tools |
| Verified | No — reported by reviewer |

## Problem
- None reads `ctx.selectionMask`, so they paint outside the active selection.
- Each stamp allocates 3 bbox-sized typed arrays (Blur) or a snapshot (Smudge); `sampleSnapshot` / `sampleSource` create a `fetch` closure per pixel (`Smudge.tsx:59`).
- They average straight-alpha RGBA, giving dark fringes against transparent pixels.
- They never call `strokeStart` / `strokeEnd`.

## Where
- `src/core/tools/Blur/Blur.tsx:38-169`
- `src/core/tools/Smudge/Smudge.tsx:59, 75-180`
- `src/core/tools/Sharpen/`, `src/core/tools/Liquify/`
- `src/core/tools/_shared/localBrush.ts`

## Suggested fix
Thread `sel` through `forEachBrushPixel`, reuse scratch buffers per handler, premultiply before averaging, and add the stroke brackets.

## Done when
- These tools respect the selection, produce no dark fringes at transparent edges, and don't allocate per stamp.


## Resolution
Changes, mostly in `_shared/localBrush.ts` and then applied per tool:
- **Selection:** `forEachBrushPixel` takes an optional `selection` (new `brushSelection(ctx)` / `selectionWeight`) and scales each pixel's weight by the mask. Blur, Sharpen, Smudge and Liquify now respect the active selection.
- **Allocations:** per-stamp snapshots/ping-pong buffers come from reusable `scratchBuffer` slots and are filled row-wise (`copyLayerRect`); Smudge's per-pixel `fetch` closure is gone.
- **Edges:** Blur's box average, Sharpen's blur term and Smudge's bilinear sample and blend are alpha-weighted (premultiplied), so there are no dark fringes against transparency.
- **Stroke brackets:** all four tools call `strokeStart`/`strokeEnd`.
- **Flushes:** moves that stamped nothing no longer trigger a full-layer upload (`flushStamps`).
