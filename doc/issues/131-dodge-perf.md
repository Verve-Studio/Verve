# 131 · Dodge/Burn allocates per pixel and grows the layer needlessly

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | Tools / Dodge |
| Verified | Yes |

## Problem
Each touched pixel stores a `samplePixel` tuple in a Map; the layer is grown although only existing pixels change.

## Where
- `src/core/tools/Dodge/dodgeBurn.ts:85-94`
- `src/core/tools/Dodge/Dodge.tsx:59-60`

## Suggested fix
Typed-array snapshot of original values; no growth.

## Done when
- No per-pixel allocation in dodge/burn.

## Resolution
Dodge/Burn stores original pixel values in lazily allocated 64×64 typed-array tiles (OriginalPixels) read straight from layer.data, instead of a Map of per-pixel tuples. It no longer grows the layer, since it only rescales existing pixels.
