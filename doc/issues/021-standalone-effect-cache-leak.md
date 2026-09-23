# 021 · Cached outputs of deleted standalone effects / adjustments are never evicted

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Stability / Memory |
| Area | GPU rendering |
| Verified | No — reported by reviewer |

## Problem
The `standaloneOp` cache is keyed by the adjustment layer id (`RenderPlanExecutor.ts:1566`) and evicted only via `destroyLayer` → `cache.disposeFor`. Adjustment layers never get a `GpuLayer` (`useGpuLayerSync.ts:107`) and the removal sweep only walks `glLayers` (`useGpuLayerSync.ts:218-231`). So deleting or hiding a standalone effect leaks a canvas-sized texture for the renderer's lifetime (256 MB each at 4K rgba32f). Same for `adjGroup` entries (keyed by `parentLayerId`) after all adjustments on a layer are removed.

## Where
- `src/graphics/webgpu/frame/RenderPlanExecutor.ts:1566`
- `src/core/services/useGpuLayerSync.ts:107, 218-231`

## Suggested fix
At the end of each full-path frame, evict cache entries whose ids weren't seen in the plan (mark-and-sweep). Or call `renderer.cache.disposeFor(id)` for removed adjustment ids in `useGpuLayerSync` step 2.

## Done when
- Adding then deleting 10 Gaussian Blur layers returns GPU memory to the baseline.


## Resolution
After each full render, `RenderPlanExecutor.sweepUnreferencedCaches()` collects every id in the (nested) plan and frees `standaloneOp`, `adjGroup`, `compositeLayer` and `bakedLocked` entries whose key is no longer referenced. It runs after submit. Hidden adjustments (omitted from the plan) are evicted too and recomputed when shown again.
