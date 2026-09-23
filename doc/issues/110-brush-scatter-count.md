# 110 · Brush scatter sub-stamps share one scatter distance

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Brush |
| Verified | Yes |

## Problem
The scatter hash ignores `countSubindex`, so all `count` stamps land on the same spot (perpendicular scatter) or on one ring.

## Where
- `src/core/tools/Brush/stampEngine.ts:543`

## Suggested fix
Mix the sub-index into the hash.

## Done when
- Scatter count > 1 spreads stamps.

## Resolution
The scatter distance hash mixes in the count sub-index.
