# 111 · Brush direction dynamics: dead half-range and 0° seed

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Brush |
| Verified | Yes |

## Problem
`pose.direction / 2π` lies in (-0.5, 0.5] and the curve clamps to [0,1], so leftward/upward strokes read 0. Direction smoothing is seeded to 0 rad by the pointer-down dot, so direction-follow tips start rotated.

## Where
- `src/core/tools/Brush/stampEngine.ts:465, 1061-1065`
- `src/core/tools/Brush/Brush.tsx:442`

## Suggested fix
Wrap to [0,1); seed smoothing from the first real segment tangent.

## Done when
- Direction dynamics respond for all directions; first stamps are oriented correctly.

## Resolution
The direction dynamic input is wrapped into [0, 1) instead of divided (leftward/upward strokes read 0 before). The pointer-down dot no longer seeds direction smoothing (reset to null after the dot), and bezierDirection falls back to the chord when the tangent is degenerate (first segment start), so direction-follow tips start correctly oriented.
