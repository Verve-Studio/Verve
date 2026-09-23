# 088 · Healing Brush clips HDR and keeps source state across tabs

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Correctness |
| Area | Tools / HealingBrush |
| Verified | No — reported by reviewer |

## Problem
Healing Brush clamps rgba32f output to [0,1] (`HealingBrush.tsx:257`). Its `healingState` (`:58`) is module-level rather than in `DocumentScope`, so the source point leaks across tabs.

## Where
- `src/core/tools/HealingBrush/HealingBrush.tsx:58, 257`

## Suggested fix
Remove the upper clamp for rgba32f (clamp only ≥ 0). Move `healingState` into `DocumentScope` like `cloneStamp`.

## Done when
- Healing on HDR keeps values > 1; setting a source in tab A doesn't apply in tab B.


## Resolution
Float output only clamps at 0 (HDR > 1 kept). Source anchor + aligned offset moved from module state into a per-document HealingSourceStore (src/core/tools/HealingBrush/healingSourceStore.ts), registered in DocumentScope and notified by setActiveScope; the handler reads ctx.scope.healingSource.
