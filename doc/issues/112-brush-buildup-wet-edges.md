# 112 · Brush build-up breaks wet edges

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Brush |
| Verified | Yes |

## Problem
Each build-up tick clears the stroke bbox and `touched`, so the stroke-end wet-edge pass only sees the last tick's footprint.

## Where
- `src/core/tools/Brush/Brush.tsx:394-405`

## Suggested fix
Track a stroke-lifetime bbox for wet edges separately from the per-tick clear box.

## Done when
- Wet edges cover the whole stroke with build-up on.

## Resolution
When wet edges are on, each build-up tick max-merges its coverage into a stroke-lifetime silhouette buffer and unions a lifetime bbox before clearing touched; the stroke-end wet-edge pass runs against that silhouette/bbox, so the rim follows the whole stroke.
