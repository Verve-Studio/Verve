# 025 · GPU readback path is fragile and GPU errors never surface

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | Medium |
| Category | Stability |
| Area | GPU readback / Rasterization |
| Verified | No — reported by reviewer |

## Problem
- `PixelReadback.readTexture` has no try/finally; if `mapAsync` rejects, the staging buffer leaks.
- If the renderer is destroyed mid-readback (tab switch during export), `release()` pushes the canvas-sized MAP_READ buffer into an already-destroyed pool, so it's never freed.
- Nothing wraps encode + submit in error scopes. A validation or OOM error in the composite submits nothing, and `mapAsync` still resolves with the previous contents of a reused pool buffer, so the export silently contains stale data.
- `RasterizationExecutionError` is defined but never thrown.

## Where
- `src/graphics/webgpu/pixelio/PixelReadback.ts:49-55`
- `StagingBufferPool.ts:32-47`
- `src/graphics/rasterization/GpuRasterPipeline.ts`

## Suggested fix
- Wrap the encode in `readFlattenedPlan` / `readAdjustmentInputPlan` with `pushErrorScope('validation')` and `pushErrorScope('out-of-memory')`; after submit, pop both and throw `RasterizationExecutionError` on error.
- try/finally for unmap and release.
- Add a `destroyed` flag to the pool so a late `release` destroys the buffer instead of pooling it.

## Done when
- A forced GPU validation error during export surfaces as an error dialog instead of producing a stale image.


## Resolution
`PixelReadback.readTexture` wraps finish+submit in validation and out-of-memory error scopes and throws if either catches something. Map/unmap/release sit in `try/finally`. `StagingBufferPool.release` destroys the buffer instead of pooling it once the pool is destroyed (or if it is still mapped). `rasterizeWithGpu` rethrows failures as `RasterizationExecutionError` (it was previously never thrown). Encode-time errors from `createBindGroup`/`createTexture` still go to the uncaptured-error handler (023); they invalidate the encoder, which the finish-time scope then catches.
