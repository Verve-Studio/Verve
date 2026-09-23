# 119 · Pencil motion blur paints outside the dirty/growth pad

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Pencil |
| Verified | Yes |

## Problem
Dab capsules extend by `size·motionBlur·0.5` but `padR` ignores it; pixels are written but not uploaded (or dropped on small layers).

## Where
- `src/core/tools/Pencil/brushStroke.ts:337-367`
- `src/core/tools/Pencil/Pencil.tsx:737-808`

## Suggested fix
Include the motion extent in `padR`.

## Done when
- Motion-blurred pencil strokes show completely.

## Resolution
Pencil's growth/dirty pad (segment and pointer-down paths) includes the motion stretch size × motionBlur / 2. The default pencil motion blur is now 0 (exact pixel footprints).
