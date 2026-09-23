# 120 · Pencil sizes don't match preview / indexed stamps

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Pencil |
| Verified | Yes |

## Problem
The size>1 path centres dabs on pixels with `dist <= size/2` (even sizes paint N+1); the indexed8 round stamp uses a `+0.5` offset that is only right for even sizes.

## Where
- `src/core/tools/Pencil/brushStroke.ts:47-56, 128-166`
- `src/core/tools/Pencil/indexedColorUtils.ts:86-106`

## Suggested fix
Use the preview's footprint rule everywhere.

## Done when
- Painted footprints equal the cursor preview for all sizes and formats.

## Resolution
New pencilFootprint.ts defines one footprint rule: a size-N box starting at c − ⌊N/2⌋, with the centre half a pixel up-left for even N. Round uses ox²+oy² ≤ N²/4 − 0.5, square fills the box, diamond uses a Manhattan bound. The cursor preview, pixel-brush preview/stamp, indexed8 stamp and hard rgba stamp all use it, and the AA rgba stamp measures from the true footprint centre. Even sizes no longer paint N+1.
