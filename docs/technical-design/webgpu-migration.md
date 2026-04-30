# Technical Design: WebGPU Migration

## Overview

This migration replaces the `src/webgl/` WebGL2 rendering backend with a `src/webgpu/` WebGPU backend. `WebGPURenderer` exposes a functionally identical public interface to `WebGLRenderer`, so the rasterization pipeline, tool layer, canvas handle, and all call sites require only import-path and type-name updates — with one structural exception: `readFlattenedPlan`, `readFlattenedPixels`, and `readAdjustmentInputPlan` must become `async` because WebGPU GPU-to-CPU pixel readback is inherently asynchronous (`mapAsync`). This async change propagates through `GpuRasterPipeline`, `UnifiedRasterPipeline`, the `CanvasHandle` interface, `useLayers`, `useExportOps`, and `useCurvesHistogram`. All ten per-pixel adjustment passes are reimplemented as WebGPU compute shaders; layer compositing, checkerboard, and screen blit remain as render pipelines.

---

## Affected Areas

| File | Change |
|---|---|
| `src/webgpu/WebGPURenderer.ts` | **Create.** Main renderer class. Drop-in replacement for `WebGLRenderer`. |
| `src/webgpu/shaders.ts` | **Create.** All WGSL shaders as TypeScript string constants. |
| `src/webgpu/utils.ts` | **Create.** Device, pipeline, texture, and buffer helpers. |
| `src/webgl/` | **Delete.** Entire directory removed after migration is complete. |
| `src/hooks/useWebGL.ts` | **Rename → `useWebGPU.ts`.** Async init via `WebGPURenderer.create`. |
| `src/rasterization/types.ts` | Update imports: `WebGLRenderer` → `WebGPURenderer`, `WebGLLayer` → `GpuLayer`. Make `rasterizeWithGpu` return `Promise`. |
| `src/rasterization/GpuRasterPipeline.ts` | Make `rasterizeWithGpu` async; `await renderer.readFlattenedPlan(...)`. |
| `src/rasterization/UnifiedRasterPipeline.ts` | Make `rasterizeDocument` async; `await rasterizeWithGpu(...)`. |
| `src/rasterization/CpuRasterPipeline.ts` | Update import path: `WebGLLayer` → `GpuLayer` from `@/webgpu/WebGPURenderer`. |
| `src/components/window/Canvas/canvasHandle.ts` | Update all imports. Make `rasterizeComposite`, `rasterizeLayers`, and `readAdjustmentInputPixels` async on the `CanvasHandle` interface and in the hook implementation. |
| `src/components/window/Canvas/canvasPlan.ts` | Update imports: `@/webgl/WebGLRenderer` → `@/webgpu/WebGPURenderer`. |
| `src/components/window/Canvas/shapeRasterizer.ts` | Update import path. |
| `src/components/window/Canvas/textRasterizer.ts` | Update import path. |
| `src/tools/types.ts` | Update import path. |
| `src/tools/algorithm/bresenham.ts` | Update import path. |
| `src/hooks/useLayers.ts` | Await `rasterizeLayers` and `rasterizeComposite` calls (lines 71, 111, 150, 206). |
| `src/hooks/useExportOps.ts` | Await `rasterizeLayers` call (line 27). |
| `src/hooks/useCurvesHistogram.ts` | Await `readAdjustmentInputPixels` call (line 94). |

---

## State Changes

No changes to `AppState`, `AppContext`, or the reducer. This migration is entirely internal to the rendering backend. The `WebGLRenderer` type reference carried in `RasterizeDocumentRequest.renderer` changes from `WebGLRenderer | null` to `WebGPURenderer | null`.

---

## New Components / Hooks / Tools

### `src/webgpu/WebGPURenderer.ts`
The main renderer class. Owns all `GPUDevice`, `GPUTexture`, `GPURenderPipeline`, and `GPUComputePipeline` instances. See §2 for the full class design.

### `src/webgpu/shaders.ts`
WGSL source strings exported as `const` TypeScript string values. Mirrors the structure of `src/webgl/shaders.ts`. See §9 for the shader design.

### `src/webgpu/utils.ts`
Stateless helpers for creating textures, buffers, bind group layouts, and pipeline descriptors. Mirrors `src/webgl/utils.ts`. See §3 for the helpers needed.

### `src/hooks/useWebGPU.ts`
Renamed from `useWebGL.ts`. Returns the same shape (`canvasRef`, `rendererRef`, `createLayer`, `render`) with updated types. Calls `await WebGPURenderer.create(...)` inside `useEffect` with a `hasInitializedRef` guard. See §8 for the full init pattern.

---

## Section 1: File Structure

```
src/
  webgpu/
    WebGPURenderer.ts   ← main renderer class (replaces src/webgl/WebGLRenderer.ts)
    shaders.ts          ← all WGSL shaders as TS string constants (replaces src/webgl/shaders.ts)
    utils.ts            ← device/pipeline/texture helpers (replaces src/webgl/utils.ts)
```

`src/webgl/` is deleted in the final migration step after all import sites are updated and typechecks pass.

---

## Section 2: Renderer Class Design

### Factory

```ts
// Async static factory — the only way to construct the renderer
static async create(
  canvas: HTMLCanvasElement,
  pixelWidth: number,
  pixelHeight: number
): Promise<WebGPURenderer>
```

The factory:
1. Checks `navigator.gpu`; throws a user-readable `WebGPUUnavailableError` if absent.
2. Requests an adapter (`navigator.gpu.requestAdapter()`) and device (`adapter.requestDevice()`).
3. Obtains a `GPUCanvasContext` from `canvas.getContext('webgpu')` and calls `context.configure(...)`.
4. Calls the private constructor, which eagerly initializes every pipeline and allocates ping-pong textures.
5. Returns the ready instance.

Synchronous construction is not supported. The `new WebGPURenderer()` constructor is private.

### Public interface (identical to `WebGLRenderer`)

| Method / property | Sync / Async | Notes |
|---|---|---|
| `pixelWidth: number` | — | readonly |
| `pixelHeight: number` | — | readonly |
| `deferFlush: boolean` | — | same semantics as WebGL |
| `createLayer(id, name, lw?, lh?, ox?, oy?): GpuLayer` | sync | allocates CPU buffer + `GPUTexture` |
| `flushLayer(layer): void` | sync | writes CPU buffer → GPU via `device.queue.writeTexture`; no-op when `deferFlush` is `true` |
| `destroyLayer(layer): void` | sync | calls `layer.texture.destroy()` |
| `growLayerToFit(layer, cx, cy, r?): boolean` | sync | doubles CPU buffer; destroys old `GPUTexture`, creates new one |
| `drawPixel(layer, x, y, r, g, b, a): void` | sync | CPU-only |
| `erasePixel(layer, x, y): void` | sync | CPU-only |
| `samplePixel(layer, x, y): [r,g,b,a]` | sync | CPU-only |
| `drawCanvasPixel(layer, cx, cy, r, g, b, a): void` | sync | CPU-only |
| `sampleCanvasPixel(layer, cx, cy): [r,g,b,a]` | sync | CPU-only |
| `canvasToLayer(layer, cx, cy)` | sync | CPU-only |
| `canvasToLayerUnchecked(layer, cx, cy)` | sync | CPU-only |
| `render(layers, maskMap?): void` | sync | builds trivial plan; calls `renderPlan` |
| `renderPlan(plan): void` | sync | encodes all GPU commands + submits |
| `readLayerPixels(layer): Uint8Array` | sync | slices CPU-side `layer.data`; no GPU round-trip |
| `readFlattenedPixels(layers, maskMap?): Promise<Uint8Array>` | **async** | calls `readFlattenedPlan` |
| `readFlattenedPlan(plan): Promise<Uint8Array>` | **async** | GPU composite + `mapAsync` readback |
| `readAdjustmentInputPlan(plan, id): Promise<Uint8Array \| null>` | **async** | GPU readback up to target adjustment; was sync in WebGL |
| `destroy(): void` | sync | destroys all `GPUTexture`s, `GPUBuffer`s, and calls `device.destroy()` |

### Private fields

```ts
private readonly device: GPUDevice
private readonly context: GPUCanvasContext
// Render pipelines
private readonly compositePipeline: GPURenderPipeline
private readonly checkerPipeline: GPURenderPipeline
private readonly blitPipeline: GPURenderPipeline
private readonly fbBlitPipeline: GPURenderPipeline
// Compute pipelines (one per adjustment kind)
private readonly bcPipeline: GPUComputePipeline
private readonly hsPipeline: GPUComputePipeline
private readonly vibPipeline: GPUComputePipeline
private readonly cbPipeline: GPUComputePipeline
private readonly bwPipeline: GPUComputePipeline
private readonly tempPipeline: GPUComputePipeline
private readonly invertPipeline: GPUComputePipeline
private readonly selColorPipeline: GPUComputePipeline
private readonly curvesPipeline: GPUComputePipeline
private readonly cgPipeline: GPUComputePipeline
// Shared sampler (nearest-neighbor, clamp-to-edge) for render pipeline texture reads
private readonly sampler: GPUSampler
// Ping-pong textures (main composite)
private pingTex: GPUTexture
private pongTex: GPUTexture
// Ping-pong textures (scoped adjustment groups)
private groupPingTex: GPUTexture
private groupPongTex: GPUTexture
// Curves LUT cache
private readonly curvesLutTextures: Map<string, { rgb: GPUTexture; red: GPUTexture; green: GPUTexture; blue: GPUTexture }>
private readonly curvesLutSignatures: Map<string, string>
readonly pixelWidth: number
readonly pixelHeight: number
deferFlush = false
```

---

## Section 3: GPU Resource Types

### Rename: `WebGLLayer` → `GpuLayer`

The `WebGLLayer` interface is renamed to `GpuLayer`. The `texture` field type changes from `WebGLTexture` to `GPUTexture`. All other fields are identical.

```ts
// src/webgpu/WebGPURenderer.ts
export interface GpuLayer {
  id: string
  name: string
  texture: GPUTexture        // was: WebGLTexture
  data: Uint8Array           // CPU-side pixel buffer
  layerWidth: number
  layerHeight: number
  offsetX: number
  offsetY: number
  opacity: number
  visible: boolean
  blendMode: string
}
```

All 9 existing import sites use `WebGLLayer` as a type only — none construct it directly. Each import site needs two changes: the import path (`@/webgl/WebGLRenderer` → `@/webgpu/WebGPURenderer`) and the type name (`WebGLLayer` → `GpuLayer`).

`AdjustmentRenderOp` and `RenderPlanEntry` are preserved verbatim (with `WebGLLayer` replaced by `GpuLayer` in their definitions). These types are imported by the rasterization pipeline, tool layer, and canvas handle; their structure must not change.

### Texture format and usages

**Layer textures** (created by `createLayer` and `growLayerToFit`):
```ts
format: 'rgba8unorm',
usage: GPUTextureUsage.TEXTURE_BINDING
      | GPUTextureUsage.COPY_DST
      | GPUTextureUsage.COPY_SRC
      | GPUTextureUsage.STORAGE_BINDING
      | GPUTextureUsage.RENDER_ATTACHMENT,
```

**Ping-pong textures** (main composite and group scope): same format and usages as layer textures.

**Curves LUT textures** (256×1):
```ts
format: 'r8unorm',           // single-channel, 8-bit
usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
```

### `utils.ts` helpers

```ts
// Texture creation
function createGpuTexture(device, w, h, format, usage): GPUTexture
function uploadTextureData(device, texture, w, h, data: Uint8Array): void  // device.queue.writeTexture

// Buffer helpers
function createUniformBuffer(device, byteSize): GPUBuffer
function writeUniformBuffer(device, buffer, data: ArrayBuffer): void       // device.queue.writeBuffer
function createReadbackBuffer(device, byteSize): GPUBuffer                 // MAP_READ | COPY_DST

// Pipeline helpers
function createShaderModule(device, wgsl: string): GPUShaderModule
function createComputePipeline(device, module, entryPoint): GPUComputePipeline
function createRenderPipeline(device, descriptor): GPURenderPipeline
```

---

## Section 4: Pipeline Inventory

### Render pipelines

| Pipeline | Purpose | Vertex shader | Fragment shader |
|---|---|---|---|
| `compositePipeline` | Porter-Duff "over" compositing of a layer rect over the running composite, supporting all 12 blend modes with optional layer mask | `vs_composite` | `fs_composite` |
| `checkerPipeline` | Full-canvas checkerboard background rendered before the first blit to the screen surface | `vs_checker` | `fs_checker` |
| `blitPipeline` | Copy the final composite texture to the `GPUCanvasContext` surface (screen blit) | `vs_blit` | `fs_blit` |
| `fbBlitPipeline` | Copy one off-screen texture to another during ping-pong compositing (FBO-to-FBO equivalent) | `vs_blit` _(same shader, same coordinates — no Y-flip needed in WebGPU)_ | `fs_blit` |

Note: in WebGPU, the `GPUCanvasContext` and off-screen textures share the same Y-axis convention (row 0 = top), so the Y-flip distinction between `BLIT_VERT` and `FBO_BLIT_VERT` in WebGL disappears. A single `vs_blit` shader handles both cases.

### Compute pipelines (one per adjustment kind)

| Pipeline | Entry point | Shader constant |
|---|---|---|
| `bcPipeline` | `cs_brightness_contrast` | `BC_COMP` |
| `hsPipeline` | `cs_hue_saturation` | `HS_COMP` |
| `vibPipeline` | `cs_color_vibrance` | `VIB_COMP` |
| `cbPipeline` | `cs_color_balance` | `CB_COMP` |
| `bwPipeline` | `cs_black_and_white` | `BW_COMP` |
| `tempPipeline` | `cs_color_temperature` | `TEMP_COMP` |
| `invertPipeline` | `cs_color_invert` | `INVERT_COMP` |
| `selColorPipeline` | `cs_selective_color` | `SEL_COLOR_COMP` |
| `curvesPipeline` | `cs_curves` | `CURVES_COMP` |
| `cgPipeline` | `cs_color_grading` | `CG_COMP` |

---

## Section 5: Bind Group Layouts

### Compute adjustment passes (all 10 adjustments share this layout, except curves)

```
@group(0) @binding(0) var srcTex    : texture_2d<f32>
@group(0) @binding(1) var dstTex    : texture_storage_2d<rgba8unorm, write>
@group(0) @binding(2) var<uniform>    params     : <AdjustmentUniformStruct>
@group(0) @binding(3) var selMask   : texture_2d<f32>
@group(0) @binding(4) var<uniform>    maskFlags  : MaskFlagsUniform
```

`MaskFlagsUniform` is `struct { hasMask: u32 }`, 16 bytes with padding. When `hasMask == 0`, the shader ignores `selMask` and applies full adjustment. When `hasMask == 1`, the R-channel of `selMask` (sampled at the current texel's integer coordinates via `textureLoad`) controls the blend weight between the original and adjusted pixel.

Each adjustment has its own uniform struct layout:

| Pipeline | Uniform struct fields |
|---|---|
| `bc` | `brightness: f32, contrast: f32` |
| `hs` | `hue: f32, saturation: f32, lightness: f32` |
| `vib` | `vibrance: f32, saturation: f32` |
| `cb` | `sha_cr: f32, sha_mg: f32, sha_yb: f32, mid_cr: f32, mid_mg: f32, mid_yb: f32, hil_cr: f32, hil_mg: f32, hil_yb: f32, preserveLuminosity: u32` |
| `bw` | `reds: f32, yellows: f32, greens: f32, cyans: f32, blues: f32, magentas: f32` |
| `temp` | `temperature: f32, tint: f32` |
| `invert` | _(no params beyond mask)_ — `params` binding is a 16-byte placeholder |
| `selColor` | `cyan: array<f32, 9>, magenta: array<f32, 9>, yellow: array<f32, 9>, black: array<f32, 9>, relative: u32` |
| `cg` | `lift: vec4f, gamma: vec4f, gain: vec4f, offset: vec4f, temp: f32, tint: f32, contrast: f32, pivot: f32, midDetail: f32, colorBoost: f32, shadows: f32, highlights: f32, saturation: f32, hue: f32, lumMix: f32` |

All uniform structs must be padded to 16-byte alignment per WGSL/WebGPU uniform buffer rules.

### Curves compute pass (extended layout)

```
@group(0) @binding(0) var srcTex     : texture_2d<f32>
@group(0) @binding(1) var dstTex     : texture_storage_2d<rgba8unorm, write>
@group(0) @binding(2) var<uniform>     params    : CurvesMetaUniform   // { _padding }
@group(0) @binding(3) var selMask    : texture_2d<f32>
@group(0) @binding(4) var<uniform>     maskFlags : MaskFlagsUniform
@group(0) @binding(5) var lutSampler : sampler
@group(0) @binding(6) var rgbLut     : texture_2d<f32>
@group(0) @binding(7) var redLut     : texture_2d<f32>
@group(0) @binding(8) var greenLut   : texture_2d<f32>
@group(0) @binding(9) var blueLut    : texture_2d<f32>
```

LUT textures are 256×1 `r8unorm`. The shader samples them via `textureSampleLevel(lut, lutSampler, vec2f(channelValue, 0.5), 0.0).r`. The sampler uses linear filtering and clamp-to-edge for smooth LUT interpolation.

LUT textures are cached by `layerId` in `curvesLutTextures`; invalidated and recreated when `curvesLutSignatures.get(layerId)` differs from the incoming LUT's hash.

### Render compositing pipeline (`compositePipeline`)

**Vertex buffers:**
- Buffer slot 0: `vec2f` positions (triangle list covering the layer's canvas-space rect)
- Buffer slot 1: `vec2f` UVs (always `[0,0]`, `[1,0]`, `[0,1]`, `[0,1]`, `[1,0]`, `[1,1]`)

**Bind group:**
```
@group(0) @binding(0) var imageSampler : sampler
@group(0) @binding(1) var layerTex    : texture_2d<f32>   // current layer (src)
@group(0) @binding(2) var dstTex      : texture_2d<f32>   // previous composite (read only)
@group(0) @binding(3) var maskTex     : texture_2d<f32>   // optional layer mask
@group(0) @binding(4) var<uniform>    compositeUniforms : CompositeUniforms
```

```wgsl
struct CompositeUniforms {
  opacity    : f32,
  blendMode  : u32,
  dstRect    : vec4f,   // (offsetX/W, offsetY/H, layerW/W, layerH/H) normalized canvas UV
  hasMask    : u32,
}
```

The `dstTex` is the current ping-pong source texture (read in the fragment shader to blend the layer over it). The render target (the write destination) is set via the `colorAttachment` of the render pass descriptor, not via a bind group binding.

### Render blit pipeline (`blitPipeline` and `fbBlitPipeline`)

```
@group(0) @binding(0) var blitSampler : sampler
@group(0) @binding(1) var srcTex      : texture_2d<f32>
```

No uniforms needed — the vertex buffer positions cover either the canvas or the full texture rect.

### Render checkerboard pipeline (`checkerPipeline`)

```
@group(0) @binding(0) var<uniform> checkerUniforms : CheckerUniforms
```

```wgsl
struct CheckerUniforms {
  tileSize   : f32,
  colorA     : vec3f,
  _pad0      : f32,
  colorB     : vec3f,
  _pad1      : f32,
  resolution : vec2f,
}
```

---

## Section 6: Ping-Pong Execution Pattern

### Structure

`WebGPURenderer` maintains two pairs of off-screen textures:
- **Main pair** (`pingTex` / `pongTex`): used during `executePlanToComposite` for the full layer stack.
- **Group pair** (`groupPingTex` / `groupPongTex`): used during `renderScopedAdjustmentGroup` for scoped adjustment evaluation.

Both textures in each pair are `rgba8unorm` with the full usage set (see §3).

### Command encoding

All passes for a single `renderPlan` / `readFlattenedPlan` call are encoded into **one `GPUCommandEncoder`** and submitted as a single `GPUCommandBuffer`. Passes execute sequentially in submission order within a single `device.queue.submit` call, so the output of pass N is available as input to pass N+1 without explicit pipeline barriers.

```ts
const encoder = device.createCommandEncoder()

// Clear both ping-pong textures via a zero-load render pass (or copyBufferToTexture)
clearTexture(encoder, pingTex)
clearTexture(encoder, pongTex)

let src = pongTex   // starts transparent
let dst = pingTex

for (const entry of plan) {
  if (entry.kind === 'layer') {
    // Render pass: blit src → dst (fbBlit), then composite layer over dst rect
    encodeCompositLayer(encoder, entry.layer, src, dst, entry.mask)
  } else if (entry.kind === 'adjustment-group') {
    // Sub-loop using group ping-pong (mirrors the main loop, scoped)
    const groupResult = encodeAdjustmentGroup(encoder, entry)
    // Render pass: composite groupResult over dst, reading from src
    encodeCompositeTexture(encoder, groupResult, src, dst, entry.baseLayer.opacity, entry.baseLayer.blendMode)
  } else /* AdjustmentRenderOp */ {
    // Compute pass: reads src, writes dst
    encodeAdjustmentComputePass(encoder, entry, src, dst)
  }
  ;[src, dst] = [dst, src]   // swap
}

// For renderPlan: encode checkerboard + final blit to GPUCanvasContext surface
const screenPass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), ... }] })
encodeCheckerboard(screenPass)
encodeBlit(screenPass, src)
screenPass.end()

device.queue.submit([encoder.finish()])
```

### `compositeLayer` step (render)

Each layer composite involves two sub-passes within the same `encoder`:
1. **FBO-blit pass**: render `src` into `dst` at full canvas size (preserves pixels outside the layer rect by rendering a full quad).
2. **Composite pass**: render the layer's texture over the layer's sub-rect only, with blend mode and mask applied. The fragment shader reads `src` (previous composite) via `dstTex` binding for Porter-Duff blending.

Both sub-passes write to `dst` as the color attachment. Between them they read `src` from a texture binding — this is safe because the two passes are sequential within the encoder.

### `encodeClearTexture`

WebGPU allows clearing a texture by starting a render pass with `loadOp: 'clear'` and `clearValue: {r:0,g:0,b:0,a:0}`, then immediately ending it. This replaces `gl.clear(gl.COLOR_BUFFER_BIT)` at initialization.

---

## Section 7: Pixel Readback

### `readFlattenedPlan` (breaking async change)

```ts
async readFlattenedPlan(plan: RenderPlanEntry[]): Promise<Uint8Array> {
  const encoder = device.createCommandEncoder()
  // ... execute plan into src texture (same as renderPlan but without screen blit) ...
  const byteSize = pixelWidth * pixelHeight * 4
  const readbackBuffer = createReadbackBuffer(device, byteSize)  // MAP_READ | COPY_DST
  encoder.copyTextureToBuffer(
    { texture: srcTex },
    { buffer: readbackBuffer, bytesPerRow: pixelWidth * 4, rowsPerImage: pixelHeight },
    { width: pixelWidth, height: pixelHeight }
  )
  device.queue.submit([encoder.finish()])
  await readbackBuffer.mapAsync(GPUMapMode.READ)
  const result = new Uint8Array(readbackBuffer.getMappedRange().slice(0))
  readbackBuffer.unmap()
  readbackBuffer.destroy()
  return result
}
```

`copyTextureToBuffer` reads texture rows top-to-bottom (row 0 = top of texture). Because WebGPU textures have Y=0 at the top (unlike OpenGL FBOs, which have Y=0 at the bottom), **no row-order flip is needed**. The output bytes match the existing top-to-bottom, left-to-right convention of `layer.data`.

The `readbackBuffer` is created and destroyed per call. For performance-critical paths, a cached readback buffer of the right size can be reused, but this is an optimization deferred to a follow-up.

### `readAdjustmentInputPlan` (also async)

Same `copyTextureToBuffer` + `mapAsync` pattern, applied to `groupPingTex` / `groupPongTex` after executing the partial plan up to the target adjustment index.

### `readLayerPixels` (remains synchronous)

Returns `layer.data.slice()`. No GPU round-trip. This is unchanged from the WebGL implementation.

### Async propagation chain

The following call chain must all become `async`:

1. `WebGPURenderer.readFlattenedPlan(plan): Promise<Uint8Array>`
2. `WebGPURenderer.readFlattenedPixels(layers, maskMap?): Promise<Uint8Array>`
3. `WebGPURenderer.readAdjustmentInputPlan(plan, id): Promise<Uint8Array | null>`
4. `GpuRasterPipeline.rasterizeWithGpu(request): Promise<RasterizeDocumentResult>`
5. `UnifiedRasterPipeline.rasterizeDocument(request): Promise<RasterizeDocumentResult>`
6. `CanvasHandle.rasterizeComposite(reason): Promise<{ data, width, height, backendUsed }>`
7. `CanvasHandle.rasterizeLayers(layers, reason): Promise<{ data, width, height, backendUsed }>`
8. `CanvasHandle.readAdjustmentInputPixels(id): Promise<Uint8Array | null>`

Call sites that must `await`:
- `useLayers.ts` line 71: `const merged = await handle.rasterizeLayers(mergeLayers, 'merge')`
- `useLayers.ts` line 111: same
- `useLayers.ts` line 150: same
- `useLayers.ts` line 206: `const flat = await handle.rasterizeComposite('flatten')`
- `useExportOps.ts` line 27: `const flat = await handle.rasterizeLayers(stateRef.current.layers, 'export')`
- `useCurvesHistogram.ts` line 94: `const sourcePixels = await handle.readAdjustmentInputPixels(adjustmentLayerId)`

The functions in `useLayers.ts` and `useExportOps.ts` that contain these calls must themselves be declared `async` (or return `Promise`). Since these are callbacks passed to `useCallback`, the callers of those callbacks must also `await` them. Audit all call sites of the affected `useLayers` functions (`flattenLayers`, `mergeDown`, `mergeVisible`) and the export function in `useExportOps` when carrying out the migration.

---

## Section 8: Async Init in `useWebGPU.ts`

```ts
// src/hooks/useWebGPU.ts
import { useRef, useEffect, useCallback } from 'react'
import { WebGPURenderer, type GpuLayer } from '@/webgpu/WebGPURenderer'

export function useWebGPU({ pixelWidth, pixelHeight }: UseWebGPUOptions): UseWebGPUReturn {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<WebGPURenderer | null>(null)
  const hasInitializedRef = useRef(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || hasInitializedRef.current) return
    hasInitializedRef.current = true

    let mounted = true
    WebGPURenderer.create(canvas, pixelWidth, pixelHeight)
      .then(renderer => {
        if (!mounted) { renderer.destroy(); return }
        rendererRef.current = renderer
      })
      .catch(err => {
        // Surface to user — e.g., dispatch a global error action
        console.error('[useWebGPU] Failed to initialize WebGPU renderer:', err)
      })

    return () => {
      mounted = false
      rendererRef.current?.destroy()
      rendererRef.current = null
      hasInitializedRef.current = false
    }
  }, [pixelWidth, pixelHeight])

  const createLayer = useCallback(
    (id: string, name: string): GpuLayer | null =>
      rendererRef.current?.createLayer(id, name) ?? null,
    []
  )

  const render = useCallback((layers: GpuLayer[], maskMap?: Map<string, GpuLayer>): void => {
    rendererRef.current?.render(layers, maskMap)
  }, [])

  return { canvasRef, rendererRef, createLayer, render }
}
```

Key rules:
- `rendererRef.current` is `null` during the async initialization window. All rendering calls that guard with `if (!renderer) return` continue to work correctly.
- The `hasInitializedRef` guard prevents double-initialization when React's StrictMode double-invokes effects in development. The `mounted` flag prevents applying a stale renderer after unmount.
- The `WebGPUUnavailableError` thrown by `WebGPURenderer.create` must be surfaced to the user as a visible error (not silently swallowed). The implementation should dispatch an error into the app's error state rather than only logging to the console.

---

## Section 9: WGSL Shader Design

All WGSL shaders are exported from `src/webgpu/shaders.ts` as named `const` string values.

### Coordinate convention in WebGPU

In WebGPU, clip-space Y=+1 corresponds to the top of the render target, and texture row 0 is also the top. There is no Y-axis inversion between off-screen textures and the canvas texture. The vertex shader maps pixel-space coordinates to clip space as:

```wgsl
ndc.x = pixelCoord.x / resolution.x * 2.0 - 1.0
ndc.y = 1.0 - pixelCoord.y / resolution.y * 2.0
```

This unified mapping replaces both `IMAGE_VERT` (no Y-flip) and `BLIT_VERT` (Y-flip) from the WebGL implementation.

### Vertex shaders (`vs_composite`, `vs_blit`, `vs_checker`)

```wgsl
// Shared vertex output
struct VertexOutput {
  @builtin(position) pos : vec4f,
  @location(0)       uv  : vec2f,
}

// vs_composite — used for layer compositing and FBO blits
@vertex
fn vs(@location(0) position: vec2f, @location(1) uv: vec2f) -> VertexOutput {
  var out: VertexOutput;
  out.pos = vec4f(
    position.x / uniforms.resolution.x * 2.0 - 1.0,
    1.0 - position.y / uniforms.resolution.y * 2.0,
    0.0, 1.0
  );
  out.uv = uv;
  return out;
}
```

The checkerboard vertex shader does not emit UVs — using `@builtin(position)` in the fragment shader directly (WebGPU fragment `position` is in framebuffer pixel coordinates, equivalent to GLSL `gl_FragCoord`).

### Fragment shaders

**`fs_composite`** — Porter-Duff over with 12 blend modes:
- Reads `layerTex` at `in.uv` (layer-local `[0,1]²` UV).
- Reads `dstTex` at the remapped canvas UV (`uniforms.dstRect.xy + in.uv * uniforms.dstRect.zw`).
- Optionally reads `maskTex` at the canvas UV; multiplies `src.a` by the mask's R channel.
- Applies the blend function indexed by `uniforms.blendMode`.
- Outputs the Porter-Duff src-over result.

The twelve blend functions (`blendNormal`, `blendMultiply`, `blendScreen`, etc.) are verbatim translations of the GLSL functions in `IMAGE_FRAG`.

**`fs_blit`** — One-to-one texture copy:
```wgsl
@fragment fn fs(in: VertexOutput) -> @location(0) vec4f {
  return textureSample(srcTex, blitSampler, in.uv);
}
```

**`fs_checker`** — Transparent checkerboard:
- Uses `in.pos.xy` (framebuffer pixel coordinates) to compute the tile pattern, identical to `CHECKER_FRAG`.

### Compute shaders (all 10 adjustments)

**Workgroup size**: `@compute @workgroup_size(8, 8)`.

**Dispatch**: `Math.ceil(width / 8)` × `Math.ceil(height / 8)` workgroups. Threads whose `id.xy` falls outside the canvas dimensions are discarded with an early return.

**Texture access**:
- Read from `srcTex` using `textureLoad(srcTex, vec2i(id.xy), 0)` — integer texel coordinates, no sampler needed for non-LUT textures.
- Write to `dstTex` using `textureStore(dstTex, vec2i(id.xy), result)`.
- For selective mask: `textureLoad(selMask, vec2i(id.xy), 0).r` gives the blend weight (0 = unaffected, 1 = full adjustment).

**Structure of every compute shader**:
```wgsl
@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var dstTex   : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params : <ShaderUniformStruct>;
@group(0) @binding(3) var selMask  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlagsUniform;

@compute @workgroup_size(8, 8)
fn cs_<name>(@builtin(global_invocation_id) id: vec3u) {
  // Dimension guard
  let dims = vec2u(textureDimensions(srcTex));
  if (id.x >= dims.x || id.y >= dims.y) { return; }

  let src = textureLoad(srcTex, vec2i(id.xy), 0);

  // Skip transparent pixels (same logic as GLSL `if (src.a < 0.0001)`)
  if (src.a < 0.0001) { textureStore(dstTex, vec2i(id.xy), src); return; }

  // ... per-shader pixel math ...
  var adjusted = vec4f(...);

  // Selective mask blend
  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) {
    mask = textureLoad(selMask, vec2i(id.xy), 0).r;
  }
  textureStore(dstTex, vec2i(id.xy), mix(src, adjusted, mask));
}
```

The per-shader math for each entry point is a WGSL translation of the corresponding GLSL fragment shader (see `src/webgl/shaders.ts`):

| Entry point | Source GLSL shader |
|---|---|
| `cs_brightness_contrast` | `BC_FRAG` |
| `cs_hue_saturation` | `HS_FRAG` (includes `rgb2hsl`/`hsl2rgb` helpers) |
| `cs_color_vibrance` | `VIB_FRAG` |
| `cs_color_balance` | `CB_FRAG` |
| `cs_black_and_white` | `BW_FRAG` (includes `rgb2hsl`, `hueDist` helpers) |
| `cs_color_temperature` | `TEMP_FRAG` |
| `cs_color_invert` | `INVERT_FRAG` |
| `cs_selective_color` | `SEL_COLOR_FRAG` (includes `rgb2hsl`, `hueDist` helpers) |
| `cs_curves` | `CURVES_FRAG` (LUT sampling via `textureSampleLevel`) |
| `cs_color_grading` | `CG_FRAG` (includes `rgb2hsl`/`hsl2rgb` helpers) |

WGSL shared helper functions (`rgb2hsl`, `hsl2rgb`, `hueDist`) are defined once as module-level functions within each shader string that requires them. There is no cross-shader include mechanism; copy into each shader that needs them.

**Selective color WGSL array uniform**: WGSL uniform structs require explicit array declarations. The selective color params are packed as:
```wgsl
struct SelectiveColorParams {
  cyan     : array<f32, 9>,
  magenta  : array<f32, 9>,
  yellow   : array<f32, 9>,
  black    : array<f32, 9>,
  relative : u32,
  _pad     : vec3u,
}
```
Total size: `9 × 4 × 4 + 4 + 12 = 160` bytes, which is correctly 16-byte aligned.

---

## Section 10: Migration Checklist Order

Execute in the following order to maintain a compilable state at each step:

1. **Create `src/webgpu/shaders.ts`** — all WGSL shaders as string constants; no other dependencies.
2. **Create `src/webgpu/utils.ts`** — depends only on `GPUDevice` / WebGPU browser types.
3. **Create `src/webgpu/WebGPURenderer.ts`** — imports `shaders.ts` and `utils.ts`; exports `WebGPURenderer`, `GpuLayer`, `AdjustmentRenderOp`, `RenderPlanEntry`.
4. **Update `src/rasterization/types.ts`** — change import from `@/webgl/WebGLRenderer` → `@/webgpu/WebGPURenderer`; rename `WebGLRenderer` → `WebGPURenderer`; change `RasterizeDocumentResult` return to `Promise<RasterizeDocumentResult>` on `rasterizeWithGpu`.
5. **Update `src/rasterization/GpuRasterPipeline.ts`** — make `rasterizeWithGpu` `async`; `await renderer.readFlattenedPlan(request.plan)`.
6. **Update `src/rasterization/UnifiedRasterPipeline.ts`** — make `rasterizeDocument` `async`; `await rasterizeWithGpu(request)`.
7. **Update `src/rasterization/CpuRasterPipeline.ts`** — update import path to `@/webgpu/WebGPURenderer`; `WebGLLayer` → `GpuLayer`.
8. **Update `src/components/window/Canvas/canvasPlan.ts`** — update import path; `WebGLLayer` → `GpuLayer`.
9. **Update `src/components/window/Canvas/shapeRasterizer.ts`** — update import path; `WebGLLayer` → `GpuLayer`.
10. **Update `src/components/window/Canvas/textRasterizer.ts`** — update import path; `WebGLLayer` → `GpuLayer`.
11. **Update `src/tools/types.ts`** — update import path; `WebGLRenderer` → `WebGPURenderer`, `WebGLLayer` → `GpuLayer`.
12. **Update `src/tools/algorithm/bresenham.ts`** — update import path; `WebGLRenderer` → `WebGPURenderer`, `WebGLLayer` → `GpuLayer`.
13. **Update `src/components/window/Canvas/canvasHandle.ts`** — update imports; make `rasterizeComposite`, `rasterizeLayers`, `readAdjustmentInputPixels` `async` on the `CanvasHandle` interface and in the hook body; `WebGLLayer` → `GpuLayer`, `WebGLRenderer` → `WebGPURenderer`.
14. **Update `src/hooks/useWebGL.ts` → `src/hooks/useWebGPU.ts`** — rename file; async init pattern (§8); update all types.
15. **Update `App.tsx` or the hook's consumer** — change `useWebGL` import to `useWebGPU`; add error display path for `WebGPUUnavailableError`.
16. **Update `src/hooks/useLayers.ts`** — add `async` to affected callbacks; `await` all `rasterizeLayers` / `rasterizeComposite` calls.
17. **Update `src/hooks/useExportOps.ts`** — add `async` to the export callback; `await rasterizeLayers`.
18. **Update `src/hooks/useCurvesHistogram.ts`** — `await readAdjustmentInputPixels`.
19. **Typecheck** — run `npm run typecheck`; resolve all remaining errors.
20. **Delete `src/webgl/`** — only after all imports have been updated and the typechecks pass.

---

## Architectural Constraints

**Unified rasterization pipeline** (`AGENTS.md`): Flatten, merge, and export must continue to run through the same centralized pipeline. Steps 4–7 above preserve this by making `GpuRasterPipeline` and `UnifiedRasterPipeline` async without changing their routing or decision logic.

**No CPU fallback** (spec): The spec explicitly prohibits a WebGL2 fallback. `src/webgl/` is deleted; no dual-backend path. If WebGPU init fails, the app surfaces a user-visible error and stops.

**`hasInitializedRef` guard** (`AGENTS.md`): Avoid re-initializing canvas layers in effects that depend on mutable refs. The `useWebGPU` init effect uses `hasInitializedRef` to prevent double initialization (§8).

**`deferFlush` flag** (spec): Must be preserved exactly. `flushLayer` checks `this.deferFlush` before calling `device.queue.writeTexture`, identical to the WebGL behavior.

**`renderPlan` stays synchronous** (spec): Only `readFlattenedPlan` (and `readAdjustmentInputPlan`) require GPU readback and are async. `renderPlan` and `render` submit to the GPU queue and return immediately — the GPU executes asynchronously without the CPU waiting.

**Pixel parity** (spec): The WGSL compute shaders are direct translations of the GLSL fragment shaders. WGSL uses `f32` throughout (matching the `precision mediump float` / `precision highp float` semantics). Parity tests should allow ±1 LSB per channel per pixel in 8-bit output to tolerate f32 rounding differences between GPU drivers.

**Y-axis convention** (implementation): Because WebGPU textures and the canvas context share the same top-to-bottom Y convention, the WebGL Y-flip distinction (`BLIT_VERT` vs. `FBO_BLIT_VERT`) is eliminated. A single `vs_blit` WGSL vertex shader handles all cases. The `copyTextureToBuffer` readback in `readFlattenedPlan` requires **no row-order flip** — unlike `gl.readPixels` in the WebGL implementation, WebGPU texture copies are already in top-to-bottom order.

---

## Open Questions

1. **Curves LUT cache invalidation key**: The WebGL implementation uses a "signature" string derived from the LUT content. The same approach carries over, but the exact signature computation (hash function, encoding) must be chosen before implementing the Curves pipeline. A cheap XOR checksum over the 256-entry arrays is sufficient for this use case.

2. **`WebGPUUnavailableError` user-facing message**: The error displayed when `navigator.gpu` is unavailable needs a UX decision (modal, banner, or initial loading screen). The technical design does not prescribe the UI; the app's error handling pattern should be followed.

3. **Readback buffer reuse**: `readFlattenedPlan` currently creates and destroys a `GPUBuffer` per call. For export paths this is fine, but for any path that calls `readFlattenedPlan` on every frame (not currently the case), a persistent cached readback buffer should be considered.

4. **`requestAdapterOptions`**: The factory should request a high-performance adapter (`powerPreference: 'high-performance'`) as Verve is a GPU-intensive application. This is an Electron app on desktop, so power consumption is less of a concern than on mobile.

5. **`rgba8unorm` storage texture write support**: All current WebGPU implementations on tier-1 desktop platforms (Chrome 113+, Electron 25+) support `rgba8unorm` as a storage texture format for write operations. If a target Electron version predates this support, switch ping-pong intermediate textures to `rgba16float` and note that the LUT textures for curves must remain `r8unorm`.
