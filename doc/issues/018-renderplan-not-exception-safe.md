# 018 · `renderPlan` isn't exception-safe; one throw crops every later frame and export

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Stability |
| Area | GPU rendering |
| Verified | Yes — confirmed in code during review |

## Problem
In the incremental path, `incrementalScissor` and `adjGroupCacheEnabled` are set before `encodeSubPlan` and reset only after it returns; the full path does the same for `adjGroupCacheEnabled`. Things that can throw mid-encode:
- `createTrackedTexture` → `memoryStore.alloc` throws `MemoryLimitError` (`src/core/store/memoryStore.ts:261`).
- `EffectEncoder.encode` throws for an unregistered kind (`EffectEncoder.ts:54`).
- Effect encode bodies.

After a throw the stale scissor stays set: `encodeCompositeLayer` clips every later full render and every `readFlattenedPlan` export to the old dirty rect, so output is silently truncated. The error disappears inside the rAF callback (`useCanvasRenderLoop.ts:206`) and never reaches the user.

## Where
- `src/graphics/webgpu/frame/RenderPlanExecutor.ts:937-949, 964-966`
- `src/core/services/useCanvasRenderLoop.ts:206`

## Suggested fix
Wrap both paths in `try/finally` that resets `incrementalScissor`, `adjGroupCacheEnabled`, `compositeBufferIndex` and flushes `pendingDestroyTextures`. Catch in `doRender` and report through `notificationStore` (rate-limited so a per-frame error doesn't spam).

## Done when
- Forcing a throw in an effect's `encode` shows one notification, and subsequent frames/exports are not cropped.


## Resolution
`RenderPlanExecutor.renderPlan` now wraps the encode (`renderPlanUnguarded`). On throw it resets `incrementalScissor`, `adjGroupCacheEnabled` and `compositeBufferIndex`, invalidates the frame cache, flushes pending destroys, and rethrows. `readFlattenedPlan` also flushes pending destroys if its encode throws. The rAF `doRender` in `useCanvasRenderLoop` catches render errors and reports them through `notificationStore`, rate-limited to one every 10 s.
