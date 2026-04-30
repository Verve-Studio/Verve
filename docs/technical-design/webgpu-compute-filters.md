# Technical Design: WebGPU Compute Shader Filter Migration

## Overview

Eleven destructive image filters (plus Bayer Dithering — thirteen operations total) currently execute on the CPU via the C++/WASM module. Because Verve already mandates WebGPU as a hard runtime requirement and `WebGPURenderer` already drives a mature `GPUComputePipeline` infrastructure for adjustment passes, these filters are a straightforward migration target. The migration introduces two new files (`src/webgpu/filterShaders.ts`, `src/webgpu/filterCompute.ts`), replaces the `@/wasm` import in thirteen call sites with `@/webgpu/filterCompute`, removes thirteen exported WASM symbols, and deletes `wasm/src/filters.cpp` / `wasm/src/filters.h` entirely. No new UI, no new `AppState` fields, no render plan changes, and no `CanvasHandle` API changes are required.

---

## Affected Areas

| File | Action | Change |
|---|---|---|
| `src/webgpu/filterShaders.ts` | **Create** | WGSL source strings for all 13 filter compute shaders |
| `src/webgpu/filterCompute.ts` | **Create** | `FilterComputeEngine` class + module-level singleton wrapper functions |
| `src/webgpu/WebGPURenderer.ts` | **Modify** | Call `initFilterCompute(device, pixelWidth, pixelHeight)` at end of constructor |
| `src/hooks/useFilters.ts` | **Modify** | Swap `import { sharpen, sharpenMore } from '@/wasm'` for `@/webgpu/filterCompute` |
| `src/components/dialogs/GaussianBlurDialog/GaussianBlurDialog.tsx` | **Modify** | Swap `gaussianBlur` import |
| `src/components/dialogs/BoxBlurDialog/BoxBlurDialog.tsx` | **Modify** | Swap `boxBlur` import |
| `src/components/dialogs/MotionBlurDialog/MotionBlurDialog.tsx` | **Modify** | Swap `motionBlur` import |
| `src/components/dialogs/RadialBlurDialog/RadialBlurDialog.tsx` | **Modify** | Swap `radialBlur` import |
| `src/components/dialogs/LensBlurDialog/LensBlurDialog.tsx` | **Modify** | Swap `lensBlur` import + add aperture mask computation |
| `src/components/dialogs/UnsharpMaskDialog/UnsharpMaskDialog.tsx` | **Modify** | Swap `unsharpMask` import |
| `src/components/dialogs/SmartSharpenDialog/SmartSharpenDialog.tsx` | **Modify** | Swap `smartSharpen` import |
| `src/components/dialogs/AddNoiseDialog/AddNoiseDialog.tsx` | **Modify** | Swap `addNoise` import |
| `src/components/dialogs/FilmGrainDialog/FilmGrainDialog.tsx` | **Modify** | Swap `filmGrain` import |
| `src/components/dialogs/CloudsDialog/CloudsDialog.tsx` | **Modify** | Swap `clouds` import |
| `src/components/dialogs/BayerDitheringDialog/BayerDitheringDialog.tsx` | **Modify** | Swap `ditherBayer` import |
| `src/wasm/index.ts` | **Modify** | Remove 13 exported async wrapper functions |
| `src/wasm/types.ts` | **Modify** | Remove 13 method signatures from `PixelOpsModule` |
| `wasm/src/pixelops.cpp` | **Modify** | Remove 13 `extern "C" EMSCRIPTEN_KEEPALIVE` wrappers |
| `wasm/CMakeLists.txt` | **Modify** | Remove 13 symbols from `-sEXPORTED_FUNCTIONS`; remove `src/filters.cpp` from sources |
| `wasm/src/filters.cpp` | **Delete** | All functions migrated to GPU |
| `wasm/src/filters.h` | **Delete** | All functions migrated to GPU |
| `wasm/src/dither.cpp` | **Modify** | Remove `dither_bayer` function body and declaration |
| `wasm/src/dither.h` | **Modify** | Remove `dither_bayer` declaration |

---

## State Changes

None. No new `AppState` fields, no new reducer actions, no new `AppContext` entries.

---

## New Files

### `src/webgpu/filterShaders.ts`

WGSL source strings for all filter compute shaders, exported as `const` TypeScript string constants. Mirrors the structure of `src/webgpu/shaders.ts`. All filter shader strings are named `FILTER_<NAME>_COMPUTE` (e.g., `FILTER_GAUSSIAN_H_COMPUTE`, `FILTER_LENS_BLUR_COMPUTE`).

### `src/webgpu/filterCompute.ts`

Contains the `FilterComputeEngine` class and a module-level singleton with wrapper functions that match the signatures of the removed WASM wrappers. Call sites change only the import path.

```ts
// Module-level singleton (same pattern as getPixelOps() in src/wasm/index.ts)
let _engine: FilterComputeEngine | null = null

export function initFilterCompute(device: GPUDevice, width: number, height: number): void {
  _engine?.destroy()
  _engine = FilterComputeEngine.create(device, width, height)
}

// Wrapper — identical signature to the removed WASM wrapper
export async function gaussianBlur(
  pixels: Uint8Array, width: number, height: number, radius: number
): Promise<Uint8Array> {
  return _engine!.gaussianBlur(pixels, width, height, radius)
}
// … one wrapper per filter
```

`FilterComputeEngine` is a class that holds:
- All 13 `GPUComputePipeline` instances (created eagerly in the constructor)
- Two `rgba16float` ping-pong textures sized to the canvas dimensions (for blur intermediates)
- One `r8unorm` noise texture (for Film Grain noise pass)
- The canvas `width` and `height`

Each async method on `FilterComputeEngine`:
1. Uploads the input `Uint8Array` to the source `rgba8unorm` temp texture (`device.queue.writeTexture`)
2. Encodes one or more `GPUComputePass` commands into a `GPUCommandEncoder`
3. Copies the result texture into an aligned readback `GPUBuffer` (`encoder.copyTextureToBuffer`)
4. Submits the encoder (`device.queue.submit`)
5. Awaits `readbuf.mapAsync(GPUMapMode.READ)`, unpacks row alignment padding, returns a tightly-packed `Uint8Array`

---

## Section 1: Compute Shader Infrastructure

### 1.1 Standard Bind Group Layout

All 13 filter shaders use the same five-binding group-0 layout, identical to the existing adjustment compute shaders in `shaders.ts`:

| Binding | Type | Description |
|---|---|---|
| 0 | `texture_2d<f32>` | Source layer (`srcTex`) — read-only |
| 1 | `texture_storage_2d<rgba8unorm, write>` | Destination (`dstTex`) — write-only |
| 2 | `var<uniform>` | Filter-specific params struct |
| 3 | `texture_2d<f32>` | Selection mask (`selMask`) — r channel = mask weight |
| 4 | `var<uniform> MaskFlags` | `{ hasMask: u32, _pad: vec3u }` |

Filters with no uniforms beyond `MaskFlags` (Sharpen, Sharpen More) use an empty 16-byte dummy params buffer at binding 2 to keep the layout uniform. Lens Blur adds a sixth binding for the aperture mask storage buffer:

| Binding | Type | Description |
|---|---|---|
| 5 | `var<storage, read> array<f32>` | Precomputed aperture weight mask |

Multi-pass filters (Gaussian Blur H+V, Box Blur H+V, Unsharp Mask, Smart Sharpen, Film Grain) swap `rgba16float` intermediate textures between passes. The selection mask is only applied in the final compositing pass; intermediate passes write to the intermediate texture unconditionally.

### 1.2 Texture Formats

| Texture | Format | Rationale |
|---|---|---|
| Source and final output | `rgba8unorm` | Matches `GpuLayer.texture` format |
| Blur intermediates | `rgba16float` | Prevents banding at radius > 32 on high-contrast edges |
| Film Grain noise field | `r8unorm` | Single-channel noise; blurred before compositing |
| Readback buffer | `rgba8unorm` (copyTextureToBuffer) | Final 8-bit output |

All textures are created with `TEXTURE_BINDING | COPY_DST | COPY_SRC | STORAGE_BINDING` usage flags.

### 1.3 Workgroup Size and Dispatch Formula

All filter shaders use `@compute @workgroup_size(8, 8)`, matching the existing adjustment shaders. Each shader begins with a bounds guard:

```wgsl
let dims = textureDimensions(srcTex);
if (id.x >= dims.x || id.y >= dims.y) { return; }
```

Dispatch: `Math.ceil(width / 8)` × `Math.ceil(height / 8)` × `1`.

### 1.4 GPU→CPU Readback

Reuses the pattern established by `WebGPURenderer.readFlattenedPlan`:

```ts
const alignedBpr = Math.ceil(width * 4 / 256) * 256
const readbuf = createReadbackBuffer(device, alignedBpr * height)
encoder.copyTextureToBuffer(
  { texture: resultTex },
  { buffer: readbuf, bytesPerRow: alignedBpr, rowsPerImage: height },
  { width, height },
)
device.queue.submit([encoder.finish()])
await readbuf.mapAsync(GPUMapMode.READ)
const result = unpackRows(new Uint8Array(readbuf.getMappedRange()), width, height, alignedBpr)
readbuf.unmap()
readbuf.destroy()
return result
```

`unpackRows` strips alignment padding from each row. This is a private static helper duplicated from `WebGPURenderer` into `FilterComputeEngine` (or extracted to `utils.ts`).

### 1.5 Pipeline Initialization

All 13 `GPUComputePipeline` instances are created eagerly in `FilterComputeEngine`'s constructor using the existing `createComputePipeline(wgsl, entryPoint)` pattern from `WebGPURenderer`. No lazy creation; pipeline compilation happens once at renderer init.

---

## Section 2: Per-Filter Specification

### 2.1 Summary Table

| Filter | Shader constant(s) | Entry point(s) | Passes | Intermediate | Uniform size |
|---|---|---|---|---|---|
| Gaussian Blur | `FILTER_GAUSSIAN_H_COMPUTE` `FILTER_GAUSSIAN_V_COMPUTE` | `cs_gaussian_h` `cs_gaussian_v` | 2 | `rgba16float` | 16 B |
| Box Blur | `FILTER_BOX_H_COMPUTE` `FILTER_BOX_V_COMPUTE` | `cs_box_h` `cs_box_v` | 2 | `rgba16float` | 16 B |
| Motion Blur | `FILTER_MOTION_BLUR_COMPUTE` | `cs_motion_blur` | 1 | — | 16 B |
| Radial Blur | `FILTER_RADIAL_BLUR_COMPUTE` | `cs_radial_blur` | 1 | — | 32 B |
| Lens Blur | `FILTER_LENS_BLUR_COMPUTE` | `cs_lens_blur` | 1 | — | 16 B + storage buf |
| Sharpen | `FILTER_SHARPEN_COMPUTE` | `cs_sharpen` | 1 | — | 0 B (dummy) |
| Sharpen More | `FILTER_SHARPEN_MORE_COMPUTE` | `cs_sharpen_more` | 1 | — | 0 B (dummy) |
| Unsharp Mask | `FILTER_GAUSSIAN_H_COMPUTE` `FILTER_GAUSSIAN_V_COMPUTE` `FILTER_UNSHARP_COMBINE_COMPUTE` | `cs_gaussian_h` `cs_gaussian_v` `cs_unsharp_combine` | 3 | `rgba16float` | 16 B (blur) + 16 B (combine) |
| Smart Sharpen | `FILTER_GAUSSIAN_H_COMPUTE` `FILTER_GAUSSIAN_V_COMPUTE` `FILTER_SMART_SHARPEN_LAPLACIAN_COMPUTE` `FILTER_SMART_SHARPEN_COMBINE_COMPUTE` | `cs_gaussian_h` `cs_gaussian_v` `cs_smart_laplacian` `cs_smart_combine` | 2–4 | `rgba16float` | 16 B (blur) + 16 B (combine) |
| Add Noise | `FILTER_ADD_NOISE_COMPUTE` | `cs_add_noise` | 1 | — | 16 B |
| Film Grain | `FILTER_FILM_GRAIN_NOISE_COMPUTE` `FILTER_FILM_GRAIN_COMBINE_COMPUTE` (+ reuse box blur shaders when grainSize > 1) | `cs_film_grain_noise` `cs_film_grain_combine` | 2–4 | `r8unorm` noise tex | 16 B (noise) + 16 B (combine) |
| Clouds | `FILTER_CLOUDS_COMPUTE` | `cs_clouds` | 1 | — | 48 B |
| Bayer Dithering | `FILTER_BAYER_DITHER_COMPUTE` | `cs_bayer_dither` | 1 | — | 16 B |

---

### 2.2 Gaussian Blur

**Passes:** H-pass then V-pass. Both reuse the same underlying shader family; separate string constants differentiate them so entry points can be distinct.

**Uniform struct (both passes):**
```wgsl
struct GaussianBlurParams {
  radius : u32,
  _pad   : vec3u,
}
```

**H-pass shader logic:** For the pixel at `(id.x, id.y)`, accumulate `(2 × radius + 1)` horizontal samples weighted by `exp(-x² / (2σ²))` where `σ = max(radius, 1) / 3.0`. Clamp sample coordinates to `[0, dims.x − 1]`. Normalise by the weight sum. Write to `rgba16float` intermediate texture (`dstTex` typed as `texture_storage_2d<rgba16float, write>` for the intermediate pass only).

**V-pass shader logic:** Same as H-pass, sampling vertically from the `rgba16float` intermediate. Final write is to `rgba8unorm` output, with selection mask applied.

**Note:** Both shaders are parameterised only by `radius`; direction is encoded in the entry point name. The intermediate texture binding 1 format changes between the H and V pass. This means two pipelines are needed even though the WGSL logic is nearly identical. Alternatively a `direction: u32` field can be added to the uniform and a single shader used with two pipelines.

**Dispatch:** `⌈width/8⌉ × ⌈height/8⌉` for each pass.

---

### 2.3 Box Blur

**Passes:** H-pass then V-pass, identical structure to Gaussian Blur.

**Uniform struct (both passes):**
```wgsl
struct BoxBlurParams {
  radius : u32,
  _pad   : vec3u,
}
```

**Shader logic:** Sample `(2 × radius + 1)` neighbors with equal weight `1 / (2 × radius + 1)`. Clamp-to-edge. Intermediate is `rgba16float` for the same precision reason as Gaussian Blur.

---

### 2.4 Motion Blur

**Passes:** 1.

**Uniform struct:**
```wgsl
struct MotionBlurParams {
  angleDeg : f32,
  distance : u32,
  _pad     : vec2u,
}
```

**Shader logic:** Compute the step vector `dx = cos(angleDeg × π / 180)`, `dy = sin(angleDeg × π / 180)`. Sample `distance` points evenly spaced from `−distance/2` to `+distance/2` along the motion axis, clamp-to-edge, average. `distance` can be up to 999, which is a high sample count per pixel but executes efficiently in parallel. No intermediate texture needed; single pass is sufficient.

---

### 2.5 Radial Blur

**Passes:** 1.

**Uniform struct:**
```wgsl
struct RadialBlurParams {
  mode    : u32,   // 0 = Spin, 1 = Zoom
  amount  : u32,   // 1–100
  quality : u32,   // sample count: 0→8, 1→16, 2→32
  _pad0   : u32,
  centerX : f32,   // 0.0–1.0 (fraction of canvas width)
  centerY : f32,   // 0.0–1.0 (fraction of canvas height)
  _pad1   : f32,
  _pad2   : f32,
}
```
**Size:** 32 bytes.

**Spin mode:** For each sample `i` in `[0, sampleCount)`, rotate `(px − cx, py − cy)` by `i × maxAngleRad / sampleCount` (where `maxAngleRad = amount × π / 180`) and accumulate. Average. Pixels exactly at the center are unblurred.

**Zoom mode:** For each sample `i`, lerp from `(px, py)` toward `(cx, cy)` by `i × stepFraction / sampleCount`. Accumulate.

---

### 2.6 Lens Blur

**Passes:** 1, with a precomputed aperture weight buffer.

**Uniform struct:**
```wgsl
struct LensBlurParams {
  radius         : u32,   // 1–100
  bladeCount     : u32,   // 3–8
  bladeCurvature : u32,   // 0–100
  rotation       : u32,   // 0–360 (degrees)
}
```

**Aperture mask:** Before dispatching, the TypeScript side precomputes a flattened `Float32Array` of `(2×radius+1)²` aperture weights:
- Build a polygon with `bladeCount` sides, radius `1.0`, rotated by `rotation` degrees.
- For each cell `(kx, ky)` where `kx, ky ∈ [−radius, radius]`, compute the signed distance to the polygon boundary. Blend between polygon and circle using `bladeCurvature / 100`.
- Normalize so the sum of all weights is `1.0`.
- Upload as a `GPUStorageBuffer` at binding 5.

At `radius = 100`, the buffer holds `201 × 201 = 40,401` floats ≈ 158 KB, well within `GPUDevice.limits.maxStorageBufferBindingSize` (typically ≥ 128 MB).

**Shader logic:** For each pixel `(px, py)`, iterate over kernel offsets `(kx, ky)`, read `apertureMask[kx + radius + (ky + radius) × kernelWidth]`, accumulate `weight × sample(px + kx, py + ky)`. Clamp-to-edge. Output weighted sum.

**Workgroup note:** At radius 100, each invocation performs up to 40,401 texture samples. This is GPU-compute's primary advantage here. Shared memory tiling is a future optimization; correctness is the priority for the initial migration.

---

### 2.7 Sharpen

**Passes:** 1.

**Uniform struct:** None. Binding 2 receives a 16-byte all-zero dummy buffer to satisfy the layout.

**Kernel (hardcoded):**
```
 0  −1   0
−1   5  −1
 0  −1   0
```
Clamp result to `[0.0, 1.0]`. Apply selection mask in the same pass (same as all other filters).

---

### 2.8 Sharpen More

**Passes:** 1. Same structure as Sharpen.

**Kernel (hardcoded):**
```
−1  −1  −1
−1   9  −1
−1  −1  −1
```

---

### 2.9 Unsharp Mask

**Passes:** 3 — H-blur → V-blur → combine.

**Blur passes:** Reuse `cs_gaussian_h` / `cs_gaussian_v` pipelines with `GaussianBlurParams { radius }`. Write to `rgba16float` intermediate.

**Combine uniform struct:**
```wgsl
struct UnsharpMaskParams {
  amount    : u32,   // 1–500
  threshold : u32,   // 0–255
  _pad      : vec2u,
}
```

**Combine shader logic (`cs_unsharp_combine`):** For each pixel, `diff = original − blurred`. Compute luminance of `diff`. If `abs(luminance) × 255.0 < threshold`, output `original` unchanged. Otherwise output `clamp(original + diff × (amount / 100.0), 0, 1)`. Binding 0 = original src, binding 1 = output dst, plus an extra binding for the blurred intermediate texture.

**Bind group for combine pass:** Requires a sixth binding for the blurred intermediate (binding 5 = `texture_2d<f32>` blurred texture). This differs from the standard 5-binding layout; the combine shader declares its own layout.

---

### 2.10 Smart Sharpen

**Passes:** 2–4, depending on mode and noise reduction setting.

| Condition | Passes |
|---|---|
| Gaussian mode, no noise reduction | 3: H-blur → V-blur → smart-combine |
| Gaussian mode, with noise reduction | 4: H-blur-NR → V-blur-NR → H-blur-sharpen → V-blur-sharpen → smart-combine (or 5 passes; see note) |
| Lens Blur (Laplacian) mode | 2: Laplacian → smart-combine |

**Noise reduction pass:** When `reduceNoise > 0`, apply a small Gaussian blur (radius clamped to `max(1, radius / 4)`) to the source before the main blur, producing a noise-suppressed input. This is two additional H+V Gaussian passes on a copy of the source.

**Laplacian pass uniform (`cs_smart_laplacian`):**
```wgsl
struct SmartLaplacianParams {
  _pad : vec4u,
}
```
No parameters; the Laplacian kernel is fixed. Produces an edge-detected approximation of Lens Blur deconvolution.

**Combine uniform struct:**
```wgsl
struct SmartSharpenParams {
  amount      : u32,   // 1–500
  radius      : u32,   // 1–64
  reduceNoise : u32,   // 0–100
  remove      : u32,   // 0 = Gaussian, 1 = Lens Blur
}
```

**Combine shader logic (`cs_smart_combine`):** Similar to Unsharp Mask combine, but `remove = 1` substitutes the Laplacian edge response for the Gaussian blur difference. `reduceNoise` attenuates sharpening in low-contrast areas proportionally.

---

### 2.11 Add Noise

**Passes:** 1.

**Uniform struct:**
```wgsl
struct AddNoiseParams {
  amount        : u32,   // 1–400
  distribution  : u32,   // 0 = Uniform, 1 = Gaussian approx
  monochromatic : u32,   // 0 or 1
  seed          : u32,
}
```

**RNG:** Per-pixel LCG must match the C++ implementation exactly for seed-parity. The C++ LCG in `filters.cpp` uses a specific multiplier/increment; replicate it exactly in WGSL. Pixel index = `global_invocation_id.y × textureDimensions(srcTex).x + global_invocation_id.x`. Initial state = `seed ^ (pixelIndex × 2654435761u)` (or whatever the C++ implementation uses — verify against `filters.cpp` source before writing the shader).

**Gaussian approximation:** Average four uniform samples, identical to the C++ implementation.

**Seed locking:** The caller generates one seed value at the moment the first preview is computed (e.g., `Math.floor(Math.random() * 0xFFFFFFFF)`) and stores it in a `useRef` inside the dialog. That seed is passed through every preview call and the final apply call. A different dialog open generates a new seed.

---

### 2.12 Film Grain

**Passes:** 2 when `grainSize == 1`; 4 when `grainSize > 1`.

**Pass 1 — noise generation (`cs_film_grain_noise`):**
```wgsl
struct FilmGrainNoiseParams {
  seed : u32,
  _pad : vec3u,
}
```
Generates a 6-octave fBm value-noise field via LCG per pixel. Writes to `r8unorm` noise texture (binding 1 typed `texture_storage_2d<r8unorm, write>`).

**Passes 2–3 — optional box blur (when grainSize > 1):**
Reuse `cs_box_h` / `cs_box_v` pipelines on the `r8unorm` noise texture with radius `grainSize / 4` (clamped to 1–50). The box blur softens the noise to produce larger grain clusters. Intermediate format for `r8unorm` blur is also `r8unorm` (single channel; no precision concerns at this bit depth).

**Final pass — combine (`cs_film_grain_combine`):**
```wgsl
struct FilmGrainCombineParams {
  grainSize : u32,   // 1–100 (used only to confirm single-channel path)
  intensity : u32,   // 1–200
  roughness : u32,   // 0–100
  _pad      : u32,
}
```
Reads source pixel and blurred noise sample. Luminance of source pixel controls roughness weighting: `weight = mix(1.0 − luma, 1.0, roughness / 100.0)`. Final output: `clamp(src + noise × (intensity / 100.0) × weight, 0, 1)`.

**Seed locking:** Same pattern as Add Noise — seed locked at first preview, reused for Apply.

---

### 2.13 Clouds

**Passes:** 1.

**Uniform struct:**
```wgsl
struct CloudsParams {
  scale     : u32,
  opacity   : u32,   // 1–100
  colorMode : u32,   // 0 = grayscale, 1 = fg/bg gradient
  seed      : u32,
  fgColor   : vec4f,
  bgColor   : vec4f,
}
```
**Size:** 48 bytes.

**Shader logic (`cs_clouds`):** Compute 6-octave fBm value noise at `(id.x / (scale × someFrequencyFactor), id.y / ...)` using the seed to offset the noise lattice. If `colorMode = 1`, use `mix(fgColor, bgColor, noiseValue)`; else use `vec4f(noiseValue, noiseValue, noiseValue, 1.0)`. Composite over source at `opacity / 100.0` via Porter-Duff over. Alpha channel of source is preserved.

**Seed locking:** The seed is a user-controlled parameter (0–9999) exposed in the Clouds dialog; the same seed always produces the same output. No runtime randomization is needed. The dialog simply passes the current seed value.

**Color mode at Apply time:** The dialog reads foreground/background colors at the time the Apply button is pressed (same moment the preview computes them). If the user changes colors while the dialog is open, the next debounced preview recomputes with the new colors.

---

### 2.14 Bayer Dithering

**Passes:** 1.

**Uniform struct:**
```wgsl
struct BayerDitherParams {
  matrixSize : u32,   // 2, 4, or 8
  _pad       : vec3u,
}
```

**Shader logic (`cs_bayer_dither`):** Embed the standard 8×8 Bayer threshold matrix as a constant array in the shader. Sub-matrices for sizes 2 and 4 are derived from the same array by modulo indexing: `threshold = bayerMatrix[(id.x % matrixSize) + (id.y % matrixSize) × matrixSize] / (matrixSize × matrixSize)`. For each RGB channel: `out = floor(src + threshold) / 255.0 × 255.0` (quantize to 8-bit). Alpha channel is passed through unchanged.

---

## Section 3: Integration Plan

### 3.1 No CanvasHandle API Changes

The existing dialog pattern is preserved:
1. Dialog reads pixels via `handle.getLayerPixels(layerId)` → canvas-sized `Uint8Array`
2. Dialog calls `await computeFilterFn(original.slice(), width, height, ...params)` → result `Uint8Array`
3. `applySelectionComposite(result, original, selectionMask)` is called CPU-side (unchanged)
4. `handle.writeLayerPixels(layerId, composed)` flushes the result to GPU
5. `captureHistory(label)` records the undo entry

The only change in each dialog is replacing the `@/wasm` import and function call with the equivalent function from `@/webgpu/filterCompute`. Function names are kept identical.

### 3.2 `useFilters.ts` Changes

```ts
// Before
import { sharpen, sharpenMore } from '@/wasm'

// After
import { sharpen, sharpenMore } from '@/webgpu/filterCompute'
```

The `handleSharpen` and `handleSharpenMore` callback bodies are unchanged.

### 3.3 `WebGPURenderer.ts` Changes

At the end of the private constructor, after all pipeline and texture initialization:

```ts
import { initFilterCompute } from './filterCompute'

// Inside WebGPURenderer constructor, after existing pipeline setup:
initFilterCompute(device, pixelWidth, pixelHeight)
```

`FilterComputeEngine.create` is called synchronously; all filter `GPUComputePipeline` instances compile at renderer init time.

### 3.4 Error Handling

Each `FilterComputeEngine` method is `async` and will throw if the `GPUDevice` is lost or a dispatch fails. The existing `try/catch` blocks in each dialog already surface errors to the user via `setErrorMessage` and restore the original pixels. No new error handling infrastructure is required.

### 3.5 Render Plan Integration (Destructive Filter Note)

These filters remain **destructive** — they bake pixel data into `layer.data` and `layer.texture`. Because the unified rasterization pipeline reads from `layer.data` (via the render plan compositing pass), flatten, export, and merge operations automatically pick up filter-modified pixels. No new `RenderPlanEntry` union variant is needed, and no `rasterization/` files change.

The spec requirement that filters be "expressible as a render-plan entry" is architecturally satisfied by the structure of `FilterComputeEngine`: its dispatch functions are pure GPU-compute operations on raw textures, and can be called from any context (future non-destructive filter layer pipeline) without coupling to dialog state. The migration does not implement non-destructive filter layers, but the compute path is ready for it.

---

## Section 4: WASM Cleanup

### 4.1 Symbols to Remove from `wasm/CMakeLists.txt`

Remove the following 13 tokens from the `-sEXPORTED_FUNCTIONS` list:

```
_pixelops_gaussian_blur
_pixelops_box_blur
_pixelops_radial_blur
_pixelops_motion_blur
_pixelops_sharpen
_pixelops_sharpen_more
_pixelops_unsharp_mask
_pixelops_smart_sharpen
_pixelops_add_noise
_pixelops_film_grain
_pixelops_lens_blur
_pixelops_clouds
_pixelops_dither_bayer
```

Also remove `src/filters.cpp` from the `add_executable(pixelops ...)` source list.

**Retained symbols (do not remove):**
`_pixelops_flood_fill`, `_pixelops_convolve`, `_pixelops_resize_bilinear`, `_pixelops_resize_nearest`, `_pixelops_dither_floyd_steinberg`, `_pixelops_quantize`, `_pixelops_curves_histogram`, `_pixelops_remove_motion_blur`.

### 4.2 Functions to Remove from `src/wasm/index.ts`

Remove these 13 exported async functions:
`gaussianBlur`, `boxBlur`, `radialBlur`, `motionBlur`, `sharpen`, `sharpenMore`, `unsharpMask`, `smartSharpen`, `addNoise`, `filmGrain`, `lensBlur`, `clouds`, `ditherBayer`.

The private helpers `withInPlaceBuffer` and `withSrcDstBuffers` are retained (still used by remaining functions). `getPixelOps` and the module singleton are retained.

### 4.3 Method Signatures to Remove from `src/wasm/types.ts`

Remove from `PixelOpsModule`:
`_pixelops_gaussian_blur`, `_pixelops_box_blur`, `_pixelops_radial_blur`, `_pixelops_motion_blur`, `_pixelops_sharpen`, `_pixelops_sharpen_more`, `_pixelops_unsharp_mask`, `_pixelops_smart_sharpen`, `_pixelops_add_noise`, `_pixelops_film_grain`, `_pixelops_lens_blur`, `_pixelops_clouds`, `_pixelops_dither_bayer`.

### 4.4 C++ Files

**Delete:** `wasm/src/filters.cpp`, `wasm/src/filters.h` (all 14 functions in `filters.h` are migrated; no other code in these files).

**Modify `wasm/src/dither.cpp` and `wasm/src/dither.h`:** Remove `dither_bayer` function declaration and implementation. The `dither_floyd_steinberg` function remains.

**Modify `wasm/src/pixelops.cpp`:** Remove the 13 `extern "C" EMSCRIPTEN_KEEPALIVE` wrapper bodies corresponding to the migrated functions. The `#include "filters.h"` include directive is removed along with the corresponding wrappers.

---

## Section 5: Key Risks

### 5.1 16-Bit Intermediates for Large Blurs

**Risk:** Using `rgba8unorm` for the intermediate Gaussian/Box blur texture introduces banding artifacts for large-radius blurs on high-contrast content. At radius 250 on a 4000×3000 canvas, accumulated rounding error across the separable passes can produce visible steps.

**Mitigation:** All blur intermediate textures (Gaussian H-pass output, Box H-pass output, Unsharp Mask blur output, Smart Sharpen blur output, Film Grain box-blur output) use `rgba16float`. The final pass converts back to `rgba8unorm`. This adds no significant memory cost (32 MB for a 4000×3000 `rgba16float` texture) and no additional passes.

**Constraint:** `rgba16float` storage binding requires `GPUFeature 'float32-filterable'` or `bgra8unorm-storage`. However, `texture_storage_2d<rgba16float, write>` is available in core WebGPU without feature flags. Verify that the `rgba16float` format is in the `supportedTextureFormats` list for the target platforms before shipping.

### 5.2 Lens Blur Kernel Size Limits

**Risk:** At radius 100, the aperture mask storage buffer is `201 × 201 × 4 = ~161 KB`. Each pixel in the compute shader reads 40,401 samples from the source texture. At 8×8 workgroup size on a 4000×3000 canvas (500×375 = 187,500 workgroups), this is 7.6 billion texture samples per dispatch. On low-end integrated GPUs this may hit WebGPU's 5-second GPU timeout, producing a `GPUDeviceLostInfo` error.

**Mitigation:**
- Cap the maximum Lens Blur radius at 100 (already the spec maximum). No additional capping needed.
- Surface the `GPUDevice` lost error clearly to the user ("Lens Blur radius too large for this GPU — try reducing the radius").
- As a future optimization (not required for initial migration): use shared memory tiling (`var<workgroup>`) to cache source texture tiles, reducing global memory bandwidth by ~8×.

### 5.3 Noise Seed Locking (Add Noise, Film Grain)

**Risk:** If the seed changes between preview and Apply, the final result differs from the previewed result, which the spec forbids.

**Mitigation:** Each dialog that uses a random seed stores one seed in a `useRef`, generated once when the dialog opens (e.g., `Math.floor(Math.random() * 0xFFFFFFFF) >>> 0`). This same ref value is passed to every preview dispatch and to the Apply dispatch. The seed ref is never updated during the dialog's lifetime. A new dialog open generates a new seed (new `useRef` initialization).

### 5.4 LCG Parity for Add Noise and Film Grain

**Risk:** The WASM C++ implementations use specific LCG parameters. If the WGSL shader uses different parameters, seed parity fails (the same seed produces different output), breaking the parity acceptance criterion.

**Mitigation:** Before writing the shaders, read `wasm/src/filters.cpp` to extract the exact LCG multiplier, increment, and per-pixel index mixing formula. Replicate them in WGSL exactly. Include a parity test that captures the C++ output for seed=0 and seed=9999 before deleting `filters.cpp`, then verifies the GPU output matches within 1 ULP.

### 5.5 `rgba16float` Texture Storage Binding Availability

**Risk:** Some WebGPU implementations may not support `texture_storage_2d<rgba16float, write>` without the `'float32-filterable'` feature.

**Mitigation:** Check `adapter.features.has('float32-filterable')` during `WebGPURenderer.create()`. If unavailable, fall back to `rgba32float` for the intermediate textures (universally supported as storage binding in WebGPU core), which uses double the memory but is guaranteed to work. Document the feature check in `filterCompute.ts`.

### 5.6 Clouds Color Mode at Apply Time

**Risk:** If the user opens the Clouds dialog, previews with color mode, changes the foreground color in the color picker without closing the dialog, then clicks Apply, the preview and the apply result could differ.

**Mitigation:** The Clouds dialog reads `fgColor` and `bgColor` from app state at the moment each preview is triggered (debounced) — not cached at open time. The Apply handler reads them again at apply time. Since both preview and apply read at their respective invocation times, they will always be consistent for the moment they execute. The edge case (user changes color mid-preview-debounce) will resolve correctly at the next debounce tick.

---

## Open Questions

1. **LCG formula verification:** The exact LCG parameters for Add Noise and Film Grain must be read from `wasm/src/filters.cpp` before writing the WGSL shaders. This is a blocking dependency on WASM source availability.

2. **`rgba16float` storage binding on target platforms:** Should be validated against the minimum platform matrix (Windows/macOS/Linux on Chrome/Edge) before committing to this format. If unavailable, the fallback to `rgba32float` doubles GPU memory for blur intermediates.

3. **Lens Blur GPU timeout threshold:** Empirical testing is needed to determine the maximum radius that completes within the GPU timeout budget on the slowest supported GPU. If the limit is lower than the 100 px spec maximum, the dialog should dynamically warn the user.

4. **Box blur shaders for `r8unorm` Film Grain noise texture:** The standard box blur shaders write to `rgba8unorm`. The Film Grain noise blur pass writes to `r8unorm`. Either a dedicated single-channel box blur shader variant is needed, or the noise texture is promoted to `rgba8unorm` (storing noise in the R channel) to reuse the existing box blur shaders. The second option is simpler and wastes 3× memory on the noise texture, which is acceptable.
