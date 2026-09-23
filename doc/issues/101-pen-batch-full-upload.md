# 101 · Pen batches upload the full active layer every frame

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Performance / Stability |
| Area | Input pipeline |
| Verified | Yes (introduced by the 006 fix) |

## Problem
`handleMoveBatch` always calls `renderer.flushLayer(ctx.layer, …)` after a coalesced batch. With no dirty rect that is a full-layer upload plus a `contentVersion` bump (invalidating render caches) — for every tool, including Hand/Select/Lasso. For tools without an active GpuLayer (adjustment layer selected) `ctx.layer` is undefined and the batch throws a TypeError.

## Where
- `src/core/services/useCanvasPointerInput.ts:131-164`
- `src/graphics/webgpu/rendering/WebGPURenderer.ts` (`flushLayer`, `deferFlush`)

## Suggested fix
While `deferFlush` is set, record the layers whose flush was deferred (with their palette) and flush exactly those at batch end.

## Done when
- A pen drag with a non-painting tool uploads nothing; painting uploads only dirty patches; no TypeError with an adjustment layer active.

## Resolution
WebGPURenderer records flushLayer calls made while deferFlush is set (layer → palette) and endDeferFlush(fallbackPalette) uploads exactly those layers once (their dirty patches). The pen batch no longer force-flushes the active layer, so non-painting tools upload nothing and no TypeError occurs without an active GpuLayer.
