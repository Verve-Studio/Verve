# 126 · Smudge and Blur can't extend beyond the layer rect

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / retouching |
| Verified | Yes |

## Problem
Neither tool grows the layer, so smudging/blurring an object outward stops at the layer rectangle.

## Where
- `src/core/tools/Smudge/Smudge.tsx`
- `src/core/tools/Blur/Blur.tsx`

## Suggested fix
Grow the layer per stamp before reading geometry.

## Done when
- Smudging outward extends the layer.

## Resolution
Smudge and Blur grow the layer to the stamp footprint (Smudge: + drag distance; Blur: + kernel reach) at the start of each stamp, before reading layer geometry or data, so smudging/blurring an object outward extends the layer.
