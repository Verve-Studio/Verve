# 115 · Brush layer growth padding ignores scatter and shear

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Brush |
| Verified | Yes |

## Problem
`padR` covers size and elongation only; scattered/sheared stamps outside the grown layer are dropped at the layer edge.

## Where
- `src/core/tools/Brush/Brush.tsx:229-247`

## Suggested fix
Include `0.5·scatter·size` and the shear extent.

## Done when
- Scattered stamps near a small layer's edge are not clipped.

## Resolution
Brush growth padding covers square/bitmap corners (√2), tilt shear, motion stretch, feathering and scatter offset.
