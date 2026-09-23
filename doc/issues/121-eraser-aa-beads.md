# 121 · 1 px anti-aliased eraser leaves partially erased beads

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Eraser |
| Verified | Yes |

## Problem
The curve is split into ~1 px Wu segments; each end pixel gets partial coverage and the max-coverage cap doesn't sum them, leaving dotted strokes.

## Where
- `src/core/tools/Eraser/eraseStroke.ts:268-285, 382`

## Suggested fix
Use the capsule-SDF path with radius 0.5 for 1 px AA erasing.

## Done when
- A 100% 1 px AA eraser stroke erases fully.

## Resolution
The anti-aliased eraser renders 1 px strokes through the capsule-SDF path (eraseAASegment, radius 0.5) instead of chained Wu segments, so joins get full coverage under the max-coverage cap.
