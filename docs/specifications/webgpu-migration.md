# WebGPU Migration

## Overview

Verve's GPU pipeline is currently implemented using WebGL2. This migration replaces that pipeline with WebGPU, the modern successor to WebGL. The change is entirely internal — no user-facing UI, behavior, or visual output changes. The primary motivation is access to **compute shaders**: WebGPU compute pipelines are better suited to per-pixel image processing operations (adjustments, color corrections, curve remapping) than WebGL2 fragment shaders, because they operate directly on storage buffers without the overhead of the rasterizer and framebuffer machinery. Layer compositing, checkerboard rendering, and the final screen blit remain as render pipelines because they produce rasterized geometry output, which render pipelines handle naturally.

## User Interaction

There is no new user interaction introduced by this feature. Users continue to open, edit, composite, and export images exactly as before. The only user-observable consequence is a startup error surfaced when WebGPU is unavailable in the runtime environment (see Edge Cases & Constraints).

## Functional Requirements

### Renderer replacement
- The `src/webgl/` directory and `WebGLRenderer` class **must** be replaced by a `src/webgpu/` directory and a `WebGPURenderer` class.
- `WebGPURenderer` **must** expose a public interface that is functionally identical to `WebGLRenderer`. All 10+ existing import sites that reference renderer types or layer types **must** require only an import-path and type-name update — no behavioral changes at call sites are needed.
- The layer data model (`WebGLLayer`-equivalent) **must** preserve all existing fields: `id`, `name`, pixel buffer, layer dimensions, canvas-space offset, `opacity`, `visible`, and `blendMode`.
- The render plan model (`RenderPlanEntry`, `AdjustmentRenderOp`) **must** be preserved exactly so the rasterization pipeline — including `UnifiedRasterPipeline`, `GpuRasterPipeline`, `CpuRasterPipeline`, and all tool-layer call sites — can continue to construct and submit plans without modification.

### Async initialization
- `WebGPURenderer` **must** be instantiated via an `async` static factory method: `WebGPURenderer.create(canvas, width, height)`.
- The factory **must** request a WebGPU adapter and device, obtain a `GPUCanvasContext`, and initialize all pipeline objects and GPU buffers before returning the renderer instance.
- Synchronous construction **must not** be supported. The single initialization site (`useWebGL` / equivalent hook) **must** be updated to `await` the factory.

### Shaders
- All GLSL shaders in `src/webgl/shaders.ts` **must** be rewritten to WGSL and located in `src/webgpu/`.
- Shader modules **must** be created via `device.createShaderModule({ code: wgslSource })`.

### Compute shaders for adjustment passes
The following ten per-pixel adjustment passes **must** be implemented as WebGPU compute pipelines using compute shaders, not render pipelines:

| Adjustment | Current pass method |
|---|---|
| Brightness / Contrast | `applyBrightnessContrastPass` |
| Hue / Saturation | `applyHueSaturationPass` |
| Color Vibrance | `applyColorVibrancePass` |
| Color Balance | `applyColorBalancePass` |
| Black and White | `applyBlackAndWhitePass` |
| Color Temperature | `applyColorTemperaturePass` |
| Color Invert | `applyInvertPass` |
| Selective Color | `applySelectiveColorPass` |
| Curves | `applyCurvesPass` |
| Color Grading | `applyColorGradingPass` |

- Each compute pass **must** read from an input `GPUTexture` (or storage buffer) and write results to an output `GPUTexture` (or storage buffer) covering the full canvas dimensions.
- Selective-mask support (the optional `selMaskLayer` parameter present in every pass) **must** be preserved: when a mask is provided, the pass **must** blend adjusted and original pixel values proportionally to the mask's red-channel alpha, exactly as today.
- Curves LUT textures **must** remain a supported mechanism for the Curves pass; the renderer **must** cache and reuse LUT textures by adjustment-layer ID and invalidate the cache when the LUT signature changes.

### Render pipelines (retained)
The following operations **must** remain as WebGPU render pipelines:

- **Layer compositing** — Porter-Duff "over" compositing of each layer's texture over the running composite, with full blend-mode support (`normal`, `multiply`, `screen`, `overlay`, `soft-light`, `hard-light`, `darken`, `lighten`, `difference`, `exclusion`, `color-dodge`, `color-burn`).
- **Checkerboard background** — full-canvas checkerboard rendered to the screen surface before the composited image is blitted.
- **Final screen blit** — copying the completed composite texture to the `GPUCanvasContext` surface.
- **FBO-to-FBO blit** — intermediate copy of one offscreen texture to another during ping-pong compositing.

### Ping-pong compositing
- The renderer **must** maintain two offscreen textures (equivalent of the current `fb0`/`fb1` pair) for main-composite ping-pong, and a separate pair for scoped adjustment-group ping-pong.
- The compositing loop pattern — reading from the "source" texture and writing to the "destination" texture, then swapping — **must** be preserved.

### Pixel read/write interface
- `drawPixel`, `erasePixel`, `samplePixel`, `drawCanvasPixel`, `sampleCanvasPixel`, `canvasToLayer`, `canvasToLayerUnchecked` **must** continue to operate on the CPU-side `Uint8Array` pixel buffer of each layer, performing no GPU round-trips.
- `flushLayer` **must** upload the CPU-side buffer to the layer's `GPUTexture` via `device.queue.writeTexture`.
- The `deferFlush` flag **must** be preserved: when `true`, `flushLayer` skips the GPU upload, allowing multiple CPU drawing calls to accumulate before a single upload.
- `readLayerPixels` **must** return a slice of the CPU-side buffer without a GPU round-trip.
- `readFlattenedPixels` and `readFlattenedPlan` **must** composite the given plan into an offscreen texture and then copy the result to a `Uint8Array` via `GPUBuffer` map-read, returning pixels in top-to-bottom, left-to-right order (index 0 = top-left pixel).
- `growLayerToFit` **must** be preserved: it doubles the CPU buffer and recreates the GPU texture to accommodate a canvas coordinate that falls outside the current layer bounds.

### Layer management
- `createLayer` **must** allocate a zeroed CPU buffer and a matching `GPUTexture` in `rgba8unorm` format.
- `destroyLayer` **must** destroy the associated `GPUTexture` and release CPU buffer memory.

### Fallback behavior
- If `navigator.gpu` is `undefined` or the adapter/device request fails at startup, Verve **must** surface a visible error message to the user explaining that WebGPU is required and is not available in the current environment.
- Verve **must not** fall back to WebGL2 or any other rendering backend. There is no silent degradation.
- Since Verve is distributed as an Electron application on supported desktop platforms (Windows, macOS, Linux), WebGPU availability is expected in all shipping configurations. The error path handles edge cases only (misconfigured environments, unsupported GPU drivers).

### Output parity
- Rendered output produced by `WebGPURenderer` **must** be pixel-identical to output produced by `WebGLRenderer` for the same document state, within floating-point rounding tolerance (maximum 1 ULP difference per channel per pixel in 8-bit output).
- This parity requirement applies to: screen preview compositing, `readFlattenedPixels`, `readFlattenedPlan`, and all flatten/export paths that run through the unified rasterization pipeline.

## Acceptance Criteria

- `WebGPURenderer.create(canvas, w, h)` returns a fully initialized renderer with no errors when called in a WebGPU-capable Electron environment.
- When WebGPU is unavailable at startup, the application displays a user-readable error and does not attempt to render.
- Each of the ten adjustment passes (brightness-contrast, hue-saturation, color-vibrance, color-balance, black-and-white, color-temperature, color-invert, selective-color, curves, color-grading) is executed as a compute shader pass — no fragment pipeline is invoked for per-pixel color transformations.
- Layer compositing (all 12 blend modes), checkerboard, and screen blit are executed as render pipeline passes — no compute shader is misused for geometry rasterization output.
- `readFlattenedPlan` produces a `Uint8Array` whose contents match the equivalent `WebGLRenderer.readFlattenedPlan` output within ±1 per channel per pixel for the same input plan.
- `flushLayer` with `deferFlush = true` does not upload to the GPU; setting `deferFlush = false` and calling `flushLayer` immediately reflects new CPU pixel data in subsequent renders.
- `growLayerToFit` correctly doubles the layer buffer and texture so that drawing at the previously out-of-bounds canvas coordinate succeeds without data corruption.
- Curves LUT textures are reused across frames for the same adjustment-layer ID, and are invalidated and recreated when the LUT content changes.
- A selective mask passed to any adjustment pass causes pixels outside the mask to be unaffected and pixels inside the mask to receive the full adjustment — matching existing behavior.
- All existing import sites referencing `WebGLRenderer`, `WebGLLayer`, `RenderPlanEntry`, and `AdjustmentRenderOp` compile without errors after updating only the import path and type names.
- The unified rasterization pipeline (`UnifiedRasterPipeline`, `GpuRasterPipeline`, `CpuRasterPipeline`) requires no behavioral changes — only import path updates.
- Flatten and export output remains pixel-identical between the WebGL2 and WebGPU pipelines (verified by parity tests comparing reference snapshots).

## Edge Cases & Constraints

- **WebGPU unavailable**: Electron ships Chromium, which includes WebGPU support on all tier-1 platforms (Windows 10+, macOS 12+, modern Linux with Vulkan). However, if the user's GPU driver is too old or the OS version is below the supported threshold, `navigator.gpu` may be `undefined`. Verve must surface this clearly and refuse to start rather than silently producing incorrect output.
- **Async initialization**: Because `WebGPURenderer.create` is async, the initialization site must `await` it before any rendering begins. Any code that previously constructed `WebGLRenderer` synchronously (e.g. inside a React effect) must be updated to handle the async lifecycle. The renderer ref must remain `null` during the async initialization window; the rendering loop must guard against a `null` renderer.
- **Floating-point parity**: WebGPU compute shaders operate in `f32`. Floating-point evaluation order and rounding may differ from WebGL2 mediump float on some drivers. Parity tests should use a tolerance of ±1 LSB in 8-bit output rather than requiring exact bit-for-bit equality.
- **`readFlattenedPlan` latency**: Reading GPU pixels requires a `mapAsync` round-trip on a `GPUBuffer`. This is inherently asynchronous. The method must return a `Promise<Uint8Array>` (the current `WebGLRenderer` method is synchronous). Call sites in the rasterization pipeline must be updated to `await` this result.
- **Texture format**: WebGPU requires explicit texture format declarations. All layer textures must use `rgba8unorm`. Framebuffer-equivalent textures used for ping-pong compositing should use `rgba16float` where precision is required (e.g. intermediate adjustment accumulation), or `rgba8unorm` where 8-bit is sufficient.
- **No WebGL fallback**: Removing the WebGL2 path entirely is intentional. Maintaining two GPU backends simultaneously is explicitly out of scope for this migration.

## Related Features

- [Unified Rasterization Pipeline](unified-rasterization-pipeline.md) — the pipeline that consumes `RenderPlanEntry` plans and must continue to work unchanged after this migration.
- [Brightness / Contrast](brightness-contrast.md), [Hue / Saturation](hue-saturation.md), [Color Vibrance](color-vibrance.md), [Color Balance](color-balance.md), [Black and White](black-and-white.md), [Color Temperature](color-temperature.md), [Color Invert](color-invert.md), [Selective Color](selective-color.md), [Curves](curves.md), [Color Grading](color-grading.md) — each adjustment whose GPU pass is being migrated from a fragment shader to a compute shader.
