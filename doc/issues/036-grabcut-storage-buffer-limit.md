# 036 · GrabCut compute fails silently above ~33 MP (storage buffer limit)

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | Medium |
| Category | Stability |
| Area | GPU compute / GrabCut |
| Verified | No — reported by reviewer |

## Problem
`GpuDevice.ts:29-32` requests only `maxTextureDimension2D` and `maxBufferSize`. GrabCut binds `w*h*4`-byte storage buffers; the default `maxStorageBufferBindingSize` is 128 MiB, so images above ~33.5 MP fail bind-group validation. The error is uncaptured and the result reads back as zeros. Also: no try/finally around `mapAsync` (buffers leak on rejection), and `initGrabCutCompute` recompiles both pipelines on every renderer construction (`WebGPURenderer.ts:300`) although the device is shared.

## Where
- `src/graphics/webgpu/device/GpuDevice.ts:29-32`
- `src/graphics/webgpu/compute/grabcutCompute.ts:184-192`
- `src/graphics/webgpu/rendering/WebGPURenderer.ts:300`

## Suggested fix
Request `adapter.limits.maxStorageBufferBindingSize`; guard or tile when over the limit; add error scopes; try/finally for map/unmap; create the engine once per device.

## Done when
- Auto-mask/GrabCut on a 50 MP image works or shows a clear error; remounts don't recompile pipelines.


## Resolution
Four changes:
- The device now requests the adapter's `maxStorageBufferBindingSize`.
- `grabCutHybrid` downsamples further when a per-pixel f32 buffer would still exceed that limit, and falls back to the all-WASM GrabCut if a GPU pass fails.
- Both GPU passes run inside validation/OOM error scopes (errors now throw instead of reading back zeros), and all buffers/textures are released in `finally` even when `mapAsync` rejects.
- `initGrabCutCompute` rebuilds pipelines only when the shared device changes, instead of on every renderer construction.
