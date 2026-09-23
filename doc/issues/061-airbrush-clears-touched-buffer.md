# 061 · Each airbrush (build-up) tick clears the whole canvas-sized touched buffer

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | Tools / Brush |
| Verified | No — reported by reviewer |

## Problem
`strokeState.touched.data.fill(0)` runs every tick (interval down to 8 ms): ~70 MB per tick on an A1 canvas, ~16 MB at 4K.

## Where
- `src/core/tools/Brush/Brush.tsx:384`

## Suggested fix
Clear only the stamp bbox (the `strokeBbox*` rect or the dot's pad-radius box).

## Done when
- Holding the airbrush still on a large canvas doesn't spike CPU.


## Resolution
Each airbrush build-up tick now clears only the stroke bbox rows of the touched buffer (the same bbox the end-of-stroke cleanup hands to `acquireTouchedBuffer`), and falls back to a full clear only when no bbox is known yet.
