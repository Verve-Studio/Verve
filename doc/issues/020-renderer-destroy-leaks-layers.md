# 020 · Layers aren't freed on Canvas unmount (leak per tab switch / resize / crop)

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Stability / Memory |
| Area | GPU rendering / WASM heap |
| Verified | Yes — confirmed in code during review |

## Problem
The `useWebGPU` cleanup only calls `renderer.destroy()`. `WebGPURenderer.destroy()` frees executor caches but never disposes `layerTextures` entries, never calls `unpinLayerFromWasm`, and never frees `touchedBuffer.wasmPtr` (allocated at `WebGPURenderer.ts:188`). Nothing iterates `glLayersRef` on unmount. The WASM `REGISTRY` (`src/wasm/wasmHeapStorage.ts:42`) holds each `GpuLayer` strongly via `onRefresh` closures, keeping its `GPUTexture` alive, so no finalizer ever fires. WASM pages stay allocated and the `memoryStore` CPU bucket isn't released, so the user eventually hits `MemoryLimitError`.

## Where
- `src/core/services/useWebGPU.ts:64-69`
- `src/graphics/webgpu/rendering/WebGPURenderer.ts:188, 845-867`
- `src/wasm/wasmHeapStorage.ts:42`

## Suggested fix
Have the renderer track a `Set<GpuLayer>` of created layers. In `destroy()`, run `destroyLayer` on each (texture destroy + WASM unpin + memoryStore release) and free `touchedBuffer`. Alternatively add an unmount cleanup that runs `destroyLayer` over `glLayersRef` and `adjustmentMaskMap` before `renderer.destroy()`.

## Done when
- Switching between two tabs 50 times leaves `memoryStore` totals and WASM heap usage flat.


## Resolution
`WebGPURenderer` tracks every layer it creates (`liveLayers`). `destroy()` now runs `destroyLayer` on each one (texture, cached outputs, WASM unpin/free), swaps a freed layer's `data` for an empty array so late readers fail visibly instead of reading reused heap memory, and frees the WASM-pinned touched buffer. Not verified in the running app; watch for any unmount-time code that still reads `layer.data` after the renderer is destroyed.
