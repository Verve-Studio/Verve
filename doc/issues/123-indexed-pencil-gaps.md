# 123 · Indexed8 pencil: no pixel-perfect, selection OOB, first-dab tiling, Map coverage

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness / Performance |
| Area | Tools / Pencil |
| Verified | Yes |

## Problem
Pixel-perfect is not applied on indexed8; `writeIndexToLayer` checks the selection without an upper bound; the first size>1 dab ignores tiled mode; indexed coverage uses a growing Map; the first 1 px pixel / pixel-brush pixels ignore HDR colour on rgba32f.

## Where
- `src/core/tools/Pencil/Pencil.tsx:939-1067`
- `src/core/tools/Pencil/indexedColorUtils.ts:56-57, 115-118`

## Suggested fix
Route indexed 1 px pixels through the pixel-perfect pipeline; add bounds checks; pass tiled dims; use a typed coverage buffer; pass `srcFloat`.

## Done when
- Indexed pencil matches rgba behaviour.

## Resolution
Indexed8 1 px strokes go through draw1pxSegment (paintOnePixel writes the palette index), so Pixel Perfect works on indexed documents, and the pending pixel is flushed at pointer-up. writeIndexToLayer bounds-checks the selection index. The indexed coverage map (a growing Map keyed ty*65536+tx) was removed, because index writes are idempotent. The first size>1 dab honours tiled mode, and on rgba32f the first 1 px pixel and pixel-brush pixels pass the linear float colour, so HDR primaries are no longer clamped.
