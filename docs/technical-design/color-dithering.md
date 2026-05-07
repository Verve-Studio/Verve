# Technical Design: Color Dithering Adjustment Layer

## Overview

Color Dithering is a non-destructive `color-adjustments` group adjustment layer that quantizes the composited pixels below it in the layer stack to the document's active palette using a user-selectable dithering algorithm. **Bayer 4×4 and Bayer 8×8** are implemented as fully GPU-parallel compute shaders dispatched synchronously in the standard adjustment pipeline — no architectural change to the render loop. **Floyd-Steinberg and Sierra Lite** are inherently sequential (each pixel depends on its predecessors' quantization error) and cannot be correctly parallelized; they are implemented via CPU/WASM and cached in `AdjustmentEncoder` as pre-computed per-layer GPU textures. The cache is invalidated and rebuilt asynchronously when params or palette change, with a one-frame passthrough fallback. A **Setup Wizard modal** gates the initial layer creation, optionally inserting a companion Reduce Colors adjustment layer below the dithering layer.

---

## Affected Areas

| File | Change |
|------|--------|
| `src/types/index.ts` | Add `'color-dithering'` to `AdjustmentType`; add `'color-dithering'` entry to `AdjustmentParamsMap`; add `ColorDitheringAdjustmentLayer` interface; extend `AdjustmentLayerState` union |
| `src/core/operations/adjustments/registry.ts` | Register `'color-dithering'` with `label: 'Color Dithering…'`, default params, `group: 'color-adjustments'` |
| `src/graphics/webgpu/types.ts` | Add `'color-dithering'` variant to `AdjustmentRenderOp` |
| `src/graphics/webgpu/shaders/adjustments/color-dithering.ts` | **New file.** Export `DITHER_BAYER_COMPUTE` WGSL shader string (Bayer 4×4 and 8×8 ordered dithering) |
| `src/graphics/webgpu/shaders/shaders.ts` | Re-export `DITHER_BAYER_COMPUTE` |
| `src/graphics/webgpu/AdjustmentEncoder.ts` | Add `bayerDitheringPipeline`; add per-layer error-diffusion texture cache and `scheduleErrorDiffusion()` async helper; add `encodeDitheringPass()` private method; extend `encode()` dispatch and `destroy()` cleanup; accept `onDitherCacheReady` callback in constructor |
| `src/ux/main/Canvas/canvasPlan.ts` | Add `'color-dithering'` case in `buildAdjustmentEntry()` |
| `src/ux/windows/ToolWindow.tsx` | Add `'color-dithering'` to `toolTitle()`, header icon SVG, icon dispatch, and panel render branch |
| `src/ux/windows/adjustments/ColorDitheringPanel/ColorDitheringPanel.tsx` | **New file.** Panel with style dropdown, opacity slider, empty-palette warning, and info note |
| `src/ux/windows/adjustments/ColorDitheringPanel/ColorDitheringPanel.module.scss` | **New file.** Panel styles |
| `src/ux/modals/ColorDitheringSetupModal/ColorDitheringSetupModal.tsx` | **New file.** Setup wizard modal |
| `src/ux/modals/ColorDitheringSetupModal/ColorDitheringSetupModal.module.scss` | **New file.** Wizard styles |
| `src/ux/index.ts` | Export `ColorDitheringPanel` and `ColorDitheringSetupModal` |
| `src/core/services/useAdjustments.ts` | Add `handleCreateColorDitheringLayers(addReduceColors: boolean): void` to hook return and implementation |
| `src/App.tsx` | Add `showColorDitheringWizard` state; intercept `adj:color-dithering` menu action to open wizard; render `ColorDitheringSetupModal` |
| `src/wasm/types.ts` | Add `ditherErrorDiffusion` function signature |
| `src/wasm/index.ts` | Add `ditherErrorDiffusion()` async wrapper |
| `wasm/src/dithering.h` | **New file.** C++ header for error-diffusion dithering |
| `wasm/src/dithering.cpp` | **New file.** C++ Floyd-Steinberg and Sierra Lite implementation |
| `wasm/src/pixelops.cpp` | Add `EMSCRIPTEN_KEEPALIVE` extern wrapper for `dither_error_diffusion` |
| `wasm/CMakeLists.txt` | Add `_dither_error_diffusion` to `-sEXPORTED_FUNCTIONS` |

---

## State Changes

No new `AppState` fields are needed. The feature slots into all existing state machinery:

- `AdjustmentLayerState` union is extended with `ColorDitheringAdjustmentLayer`.
- `openAdjustmentLayerId` already handles the panel open/close lifecycle.
- The Setup Wizard gate is a local `useState(false)` in `App.tsx` — it is purely UI flow and does not belong in global app state.

---

## New Components / Hooks / Tools

### `ColorDitheringSetupModal` — modal

- **Location:** `src/ux/modals/ColorDitheringSetupModal/`
- **Responsibility:** One-time wizard shown before the adjustment layer is created. Presents the optional "Also add a Reduce Colors" checkbox and an "Open Generate Palette…" link, then triggers layer creation via `onProceed` when the user clicks Proceed. Does not dispatch anything itself — the parent (`App.tsx`) calls `useAdjustments.handleCreateColorDitheringLayers()`.
- **Props:** `open: boolean`, `onClose: () => void`, `onProceed: (addReduceColors: boolean) => void`, `onOpenGeneratePalette: () => void`

### `ColorDitheringPanel` — floating window panel

- **Location:** `src/ux/windows/adjustments/ColorDitheringPanel/`
- **Responsibility:** Panel with Dithering Style dropdown and Opacity slider. Dispatches `UPDATE_ADJUSTMENT_LAYER` on every control change. Reads `AppContext.state.swatches` directly (it is a `ux/windows/` component, not a widget) to display the empty-palette warning when needed.
- **Props:** `layer: ColorDitheringAdjustmentLayer`, `parentLayerName: string`

### `handleCreateColorDitheringLayers` — new method on `useAdjustments`

- **Responsibility:** Encapsulates the multi-dispatch logic for the wizard Proceed action. Computes `effectiveParentId` (reusing the same logic as `handleCreateAdjustmentLayer`), optionally creates a Reduce Colors adjustment layer without opening its panel, then creates the Color Dithering layer and opens its panel.
- Lives in `useAdjustments` — business logic belongs in a hook, not inline in `App.tsx`.

---

## Implementation Steps

### Step 1 — Types (`src/types/index.ts`)

Add `'color-dithering'` to the `AdjustmentType` union:

```ts
export type AdjustmentType =
  // ... existing entries ...
  | 'color-dithering'
```

Add the params entry to `AdjustmentParamsMap`:

```ts
'color-dithering': {
  style:   'bayer4' | 'bayer8' | 'floyd-steinberg' | 'sierra-lite'
  opacity: number  // 0–100 (%)
}
```

Add the layer interface (follow the existing pattern exactly):

```ts
export interface ColorDitheringAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'color-dithering'
  params: AdjustmentParamsMap['color-dithering']
  hasMask: boolean
}
```

Extend `AdjustmentLayerState`:

```ts
export type AdjustmentLayerState =
  // ... existing members ...
  | ColorDitheringAdjustmentLayer
```

---

### Step 2 — Registry (`src/core/operations/adjustments/registry.ts`)

Append to `ADJUSTMENT_REGISTRY` (after `'reduce-colors'`, before the `'bloom'` entry, to keep all `color-adjustments` together):

```ts
{
  adjustmentType: 'color-dithering' as const,
  label: 'Color Dithering…',
  defaultParams: { style: 'bayer4', opacity: 100 },
  group: 'color-adjustments',
},
```

---

### Step 3 — AdjustmentRenderOp (`src/graphics/webgpu/types.ts`)

Append to the `AdjustmentRenderOp` discriminated union:

```ts
| {
    kind:         'color-dithering'
    layerId:      string
    style:        'bayer4' | 'bayer8' | 'floyd-steinberg' | 'sierra-lite'
    opacity:      number        // 0..1 (pre-divided by 100)
    palette:      Float32Array  // 256 × 4, raw sRGB bytes (0–255) stored as f32
    paletteCount: number        // 0–256
    visible:      boolean
    selMaskLayer?: GpuLayer
  }
```

**Note on color space:** unlike `reduce-colors`, which converts the palette to Oklab in `canvasPlan.ts` for perceptual nearest-color matching, dithering stores raw sRGB bytes (0–255 as f32). This is correct: (a) Bayer threshold offsets are conventionally applied in raw sRGB byte space, (b) the WASM error-diffusion code works in sRGB, and (c) the visual character of classic platform dithering is sRGB-space quantization. Both paths must use the same color space for consistency.

---

### Step 4 — Render-plan mapping (`src/ux/main/Canvas/canvasPlan.ts`)

Add a case in `buildAdjustmentEntry()`, after the `'reduce-colors'` branch:

```ts
if (ls.adjustmentType === 'color-dithering') {
  const paletteCount = Math.min(swatches.length, 256)
  const palette = new Float32Array(256 * 4)
  for (let i = 0; i < paletteCount; i++) {
    palette[i * 4 + 0] = swatches[i].r
    palette[i * 4 + 1] = swatches[i].g
    palette[i * 4 + 2] = swatches[i].b
    palette[i * 4 + 3] = swatches[i].a
  }
  return {
    kind:         'color-dithering',
    layerId:      ls.id,
    style:        ls.params.style,
    opacity:      ls.params.opacity / 100,
    palette,
    paletteCount,
    visible:      ls.visible,
    selMaskLayer: mask,
  }
}
```

This replaces the `_exhaustive` guard as the last pattern before it — do not remove the guard itself.

---

### Step 5 — WGSL Bayer Shader (`src/graphics/webgpu/shaders/adjustments/color-dithering.ts`)

**New file.** Export the string constant `DITHER_BAYER_COMPUTE`.

#### Bind group layout

| Binding | Type | Description |
|---------|------|-------------|
| 0 | `texture_2d<f32>` (read) | Source texture |
| 1 | `texture_storage_2d<rgba8unorm, write>` | Destination texture |
| 2 | `uniform buffer` | `DitheringUniforms` (16 bytes) |
| 3 | `texture_2d<f32>` (read) | Selection mask (or `srcTex` as dummy when no mask) |
| 4 | `uniform buffer` | `MaskFlags` (32 bytes, same layout as every other pass) |
| 5 | `read-only storage buffer` | Palette: `array<vec4f, 256>` (4096 bytes) |

This bind group shape is identical to `encodeReduceColorsPass` (bindings 0–4 match all standard passes; binding 5 is the storage buffer). The existing `createStorageBuffer` utility can be reused without change.

#### WGSL uniform struct

The struct must be **exactly 16 bytes** (one `vec4<f32>` slot, naturally aligned):

```wgsl
struct DitheringUniforms {
  paletteCount : u32,
  style        : u32,   // 0 = bayer4, 1 = bayer8
  opacity      : f32,
  _pad         : f32,
}
```

#### Embedded Bayer matrices

Declare as WGSL `const` arrays (values are already divided by matrix size, i.e. in 0..1 range):

```wgsl
const BAYER4 = array<f32, 16>(
   0.0/16.0,  8.0/16.0,  2.0/16.0, 10.0/16.0,
  12.0/16.0,  4.0/16.0, 14.0/16.0,  6.0/16.0,
   3.0/16.0, 11.0/16.0,  1.0/16.0,  9.0/16.0,
  15.0/16.0,  7.0/16.0, 13.0/16.0,  5.0/16.0,
);

const BAYER8 = array<f32, 64>(
  // Standard 8×8 Bayer matrix values / 64.0 — 64 entries
);
```

#### Per-pixel compute logic (entry point `cs_dither_bayer`)

```wgsl
@compute @workgroup_size(8, 8)
fn cs_dither_bayer(@builtin(global_invocation_id) gid: vec3u) {
  let w = textureDimensions(src).x;
  let h = textureDimensions(src).y;
  if (gid.x >= w || gid.y >= h) { return; }

  let coord = vec2i(i32(gid.x), i32(gid.y));
  let src_px = textureLoad(src, coord, 0);  // 0..1 rgba

  // Bayer threshold lookup
  let t: f32;
  if (uniforms.style == 0u) {
    let idx = (gid.y % 4u) * 4u + (gid.x % 4u);
    t = BAYER4[idx];
  } else {
    let idx = (gid.y % 8u) * 8u + (gid.x % 8u);
    t = BAYER8[idx];
  }

  // Apply threshold offset in 0-255 sRGB byte space
  let offset = (t - 0.5) * 255.0;
  let perturbed = clamp(src_px.rgb * 255.0 + offset, vec3f(0.0), vec3f(255.0));

  // Nearest palette color (sRGB Euclidean)
  var bestDist = 1e9;
  var bestRgb = vec3f(0.0);
  for (var i = 0u; i < uniforms.paletteCount; i++) {
    let pc = palette[i].rgb;  // 0..255 sRGB
    let d = length(perturbed - pc);
    if (d < bestDist) { bestDist = d; bestRgb = pc; }
  }

  // Blend with original at opacity and convert back to 0..1
  let dithered = bestRgb / 255.0;
  var out_rgb = mix(src_px.rgb, dithered, uniforms.opacity);

  // Selection mask
  let hasMask = maskFlags.value != 0u;
  if (hasMask) {
    let maskAlpha = textureLoad(selMask, coord, 0).r;
    out_rgb = mix(src_px.rgb, out_rgb, maskAlpha);
  }

  textureStore(dst, coord, vec4f(out_rgb, src_px.a));
}
```

Re-export from `shaders.ts`:

```ts
export { DITHER_BAYER_COMPUTE } from './adjustments/color-dithering'
```

---

### Step 6 — WASM Error Diffusion

#### C++ implementation (`wasm/src/dithering.h`, `wasm/src/dithering.cpp`)

```cpp
// dithering.h
#pragma once
#include <cstdint>

// Applies error-diffusion dithering in-place on `pixels` (RGBA, width × height × 4).
// palette: RGBA bytes, paletteCount × 4.
// style: 0 = Floyd-Steinberg, 1 = Sierra Lite.
// opacity: 0.0–1.0 blend factor between dithered and original.
void dither_error_diffusion(
  uint8_t* pixels, int width, int height,
  const uint8_t* palette, int paletteCount,
  int style, float opacity
);
```

The implementation:
1. Allocates a `float[width * height * 3]` error accumulation buffer (RGB f32), zero-initialised.
2. Scans pixels left-to-right, top-to-bottom. For each pixel at `(x, y)`:
   a. Adds accumulated error to the pixel's RGB (clamped to 0–255).
   b. Finds the nearest palette color by Euclidean RGB distance.
   c. Computes `error = perturbed − nearest` per channel.
   d. Distributes error to neighbors according to the chosen kernel:
      - **Floyd-Steinberg:** right `(7/16)`, bottom-left `(3/16)`, below `(5/16)`, bottom-right `(1/16)`.
      - **Sierra Lite:** right `(2/4)`, bottom-left `(1/4)`, below `(1/4)`.
   e. Writes `lerp(original, quantized, opacity)` back to `pixels` (alpha unchanged).
3. Frees the error buffer.

The function is bounds-safe (no error distributed outside the image bounds) and operates entirely in sRGB byte space, consistent with the Bayer shader.

#### `pixelops.cpp` wrapper

```cpp
extern "C" EMSCRIPTEN_KEEPALIVE
void dither_error_diffusion(
  uint8_t* pixels, int w, int h,
  const uint8_t* palette, int palCount,
  int style, float opacity
) {
  ::dither_error_diffusion(pixels, w, h, palette, palCount, style, opacity);
}
```

#### `CMakeLists.txt`

Add `_dither_error_diffusion` to the `-sEXPORTED_FUNCTIONS` list.

#### TypeScript wrapper (`src/wasm/types.ts`, `src/wasm/index.ts`)

Add to `types.ts`:

```ts
ditherErrorDiffusion: (
  pixelsPtr: number,
  width: number,
  height: number,
  palettePtr: number,
  paletteCount: number,
  style: number,
  opacity: number
) => void
```

Add to `index.ts` (using the standard `withInPlaceBuffer` pattern for `pixels`, and a separate `_malloc`/`_free` pair for the read-only `palette`):

```ts
export async function ditherErrorDiffusion(
  pixels: Uint8Array,
  width: number,
  height: number,
  palette: Uint8Array,
  paletteCount: number,
  style: 'floyd-steinberg' | 'sierra-lite',
  opacity: number,
): Promise<Uint8Array>
```

---

### Step 7 — AdjustmentEncoder (`src/graphics/webgpu/AdjustmentEncoder.ts`)

#### Constructor signature change

Add an `onDitherCacheReady` callback (the sole new constructor parameter):

```ts
constructor(
  device: GPUDevice,
  pixelWidth: number,
  pixelHeight: number,
  onDitherCacheReady: () => void,
)
```

`WebGPURenderer` is the only call site (`new AdjustmentEncoder(device, pixelWidth, pixelHeight)` at line 169). Update that call to pass a redraw callback — e.g. `() => this.requestRender()` if such a method exists, or expose a minimal one. If no redraw trigger exists in the renderer, the callback can be passed in from `Canvas.tsx` (where `WebGPURenderer` is created) and threaded through.

#### New pipeline field

```ts
private readonly bayerDitheringPipeline: GPUComputePipeline
```

Compiled in the constructor:

```ts
this.bayerDitheringPipeline = createComputePipeline(device, DITHER_BAYER_COMPUTE, 'cs_dither_bayer')
```

Import `DITHER_BAYER_COMPUTE` from `'./shaders/shaders'`.

#### Error-diffusion texture cache

```ts
private readonly ditheringCache = new Map<string, { signature: string; tex: GPUTexture }>()
private readonly pendingDitherRefresh = new Set<string>()
```

Keys are `layerId`. `signature` is a hash computed from `(style, opacity, paletteCount, palette bytes slice)` that changes whenever the effective dither output must change. `tex` is a full-canvas `rgba8unorm` `GPUTexture`.

#### `destroy()` additions

```ts
for (const entry of this.ditheringCache.values()) entry.tex.destroy()
this.ditheringCache.clear()
```

#### `encodeDitheringPass()` private method

```ts
private encodeDitheringPass(
  encoder: GPUCommandEncoder,
  srcTex: GPUTexture,
  dstTex: GPUTexture,
  op: ColorDitheringRenderOp,
): void
```

where `ColorDitheringRenderOp` is the `{ kind: 'color-dithering'; ... }` variant extracted as a local type alias for clarity.

**Bayer path** (`op.style === 'bayer4' || op.style === 'bayer8'`):

Follows the exact same structure as `encodeReduceColorsPass`:
1. Build `paramsData: Uint32Array[8]` where `[0] = paletteCount`, `[1] = style === 'bayer4' ? 0 : 1` (reusing the 32-byte params buffer as u32s — but note the uniform struct is 16 bytes with the third element as a float32 for opacity, so use `ArrayBuffer` directly):

```ts
const buf = new ArrayBuffer(16)
const u = new Uint32Array(buf)
const f = new Float32Array(buf)
u[0] = op.paletteCount
u[1] = op.style === 'bayer4' ? 0 : 1
f[2] = op.opacity
f[3] = 0  // _pad
```

2. Write to a 16-byte uniform buffer.
3. Write `op.palette` (Float32Array, 4096 bytes) to a storage buffer using `createStorageBuffer`.
4. Build bind group with bindings 0–5 as described in Step 5.
5. Dispatch workgroups: `(ceil(w/8), ceil(h/8))`.
6. Push uniform and storage buffers to `pendingDestroyBuffers`.

**Error-diffusion path** (`'floyd-steinberg'` or `'sierra-lite'`):

```ts
const sig = this.buildDitheringSignature(op)
const cached = this.ditheringCache.get(op.layerId)

if (cached && cached.signature === sig) {
  // Cache hit: blit cached result to dstTex with a passthrough copy
  this.encodeTextureCopy(encoder, cached.tex, dstTex)
  return
}

// Cache miss: passthrough for this frame, schedule async refresh
this.encodeTextureCopy(encoder, srcTex, dstTex)
if (!this.pendingDitherRefresh.has(op.layerId)) {
  this.pendingDitherRefresh.add(op.layerId)
  void this.scheduleErrorDiffusion(srcTex, op, sig)
}
```

**`scheduleErrorDiffusion()` async helper (private):**

```ts
private async scheduleErrorDiffusion(
  srcTex: GPUTexture,
  op: ColorDitheringRenderOp,
  sig: string,
): Promise<void> {
  const { device, pixelWidth: w, pixelHeight: h } = this

  // 1. GPU readback of srcTex
  const byteSize = w * h * 4
  const readbackBuf = device.createBuffer({
    size: byteSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const cmdEncoder = device.createCommandEncoder()
  cmdEncoder.copyTextureToBuffer(
    { texture: srcTex },
    { buffer: readbackBuf, bytesPerRow: w * 4 },
    { width: w, height: h },
  )
  device.queue.submit([cmdEncoder.finish()])
  await readbackBuf.mapAsync(GPUMapMode.READ)
  const srcPixels = new Uint8Array(readbackBuf.getMappedRange().slice(0))
  readbackBuf.unmap()
  readbackBuf.destroy()

  // 2. Build palette as Uint8Array (RGBA bytes)
  const palBytes = new Uint8Array(op.paletteCount * 4)
  for (let i = 0; i < op.paletteCount; i++) {
    palBytes[i * 4 + 0] = op.palette[i * 4 + 0]
    palBytes[i * 4 + 1] = op.palette[i * 4 + 1]
    palBytes[i * 4 + 2] = op.palette[i * 4 + 2]
    palBytes[i * 4 + 3] = op.palette[i * 4 + 3]
  }

  // 3. WASM error diffusion (modifies srcPixels in place)
  const result = await ditherErrorDiffusion(
    srcPixels, w, h,
    palBytes, op.paletteCount,
    op.style as 'floyd-steinberg' | 'sierra-lite',
    op.opacity,
  )

  // 4. Upload to cached texture (create or reuse)
  const existing = this.ditheringCache.get(op.layerId)
  let tex: GPUTexture
  if (existing) {
    tex = existing.tex
  } else {
    tex = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    })
  }
  device.queue.writeTexture(
    { texture: tex },
    result,
    { bytesPerRow: w * 4 },
    { width: w, height: h },
  )
  this.ditheringCache.set(op.layerId, { signature: sig, tex })
  this.pendingDitherRefresh.delete(op.layerId)

  // 5. Trigger re-render so the next frame uses the cached result
  this.onDitherCacheReady()
}
```

**`encodeTextureCopy()` helper** (or reuse an existing blit pass if one exists in the encoder). A direct `GPUCommandEncoder.copyTextureToTexture()` can be used since both textures share the same format and dimensions.

**`buildDitheringSignature()` helper:**

```ts
private buildDitheringSignature(op: ColorDitheringRenderOp): string {
  return `${op.style}|${op.opacity.toFixed(4)}|${op.paletteCount}|${op.palette.subarray(0, op.paletteCount * 4).join(',')}`
}
```

#### `encode()` dispatch addition

Add the following case **before** the `_exhaustive: never` guard:

```ts
if (entry.kind === 'color-dithering') {
  this.encodeDitheringPass(encoder, srcTex, dstTex, entry)
  return
}
```

---

### Step 8 — `useAdjustments` hook (`src/core/services/useAdjustments.ts`)

Add `handleCreateColorDitheringLayers(addReduceColors: boolean): void` to `UseAdjustmentsReturn` and implement it in the hook body.

The implementation mirrors `handleCreateAdjustmentLayer`'s `effectiveParentId` logic:

```ts
const handleCreateColorDitheringLayers = useCallback((addReduceColors: boolean): void => {
  const { activeLayerId, layers, openAdjustmentLayerId } = stateRef.current

  if (openAdjustmentLayerId !== null) {
    adjustmentPreviewStore.clear(openAdjustmentLayerId)
    captureHistory('Adjustment')
    dispatch({ type: 'SET_OPEN_ADJUSTMENT', payload: null })
  }

  const activeLayer = layers.find(l => l.id === activeLayerId)
  if (!activeLayer) return

  let effectiveParentId: string
  if (isEffectEligibleLayer(activeLayer)) {
    effectiveParentId = activeLayerId!
  } else if ('type' in activeLayer && activeLayer.type === 'adjustment') {
    const parentId = (activeLayer as { parentId: string }).parentId
    const parentLayer = layers.find(l => l.id === parentId)
    if (!parentLayer || !isEffectEligibleLayer(parentLayer)) return
    effectiveParentId = parentId
  } else {
    return
  }

  const selPixels = getSelectionPixels ? getSelectionPixels() : null
  const hasMask = selPixels !== null

  // Optionally insert Reduce Colors layer first (will appear below Color Dithering in the panel)
  if (addReduceColors) {
    const rcLayer: AdjustmentLayerState = {
      id: `adj-${Date.now()}-rc`,
      name: 'Reduce Colors',
      visible: true,
      type: 'adjustment',
      parentId: effectiveParentId,
      adjustmentType: 'reduce-colors',
      params: { mode: 'palette', colorCount: 16, derivedPalette: null },
      hasMask: false,
    }
    dispatch({ type: 'ADD_ADJUSTMENT_LAYER', payload: rcLayer })
    // No SET_OPEN_ADJUSTMENT — only the Color Dithering panel opens
  }

  const ditheringEntry = ADJUSTMENT_REGISTRY.find(e => e.adjustmentType === 'color-dithering')!
  const newId = `adj-${Date.now()}`
  const ditheringLayer: AdjustmentLayerState = {
    id: newId,
    name: 'Color Dithering',
    visible: true,
    type: 'adjustment',
    parentId: effectiveParentId,
    adjustmentType: 'color-dithering',
    params: { ...ditheringEntry.defaultParams },
    hasMask,
  }
  dispatch({ type: 'ADD_ADJUSTMENT_LAYER', payload: ditheringLayer })
  dispatch({ type: 'SET_OPEN_ADJUSTMENT', payload: newId })

  if (selPixels && registerAdjMask) {
    registerAdjMask(newId, selPixels)
  }
}, [stateRef, captureHistory, dispatch, getSelectionPixels, registerAdjMask])
```

**Layer insertion order:** `ADD_ADJUSTMENT_LAYER` is expected to append to the layers array in the reducer. Dispatching reduce-colors first means it appears earlier in the array → it is composited (applied) first → color-dithering operates on its output. This is the correct behavior: Reduce Colors maps pixels to the palette, then Color Dithering dithers the result. Confirm the reducer appends (see open questions).

---

### Step 9 — Panel Component (`src/ux/windows/adjustments/ColorDitheringPanel/`)

**`ColorDitheringPanel.tsx`:**

```tsx
import React from 'react'
import { useAppContext } from '@/core/store/AppContext'
import type { ColorDitheringAdjustmentLayer } from '@/types'
import styles from './ColorDitheringPanel.module.scss'

interface ColorDitheringPanelProps {
  layer: ColorDitheringAdjustmentLayer
  parentLayerName: string
}

export function ColorDitheringPanel({ layer, parentLayerName }: ColorDitheringPanelProps): React.JSX.Element {
  const { state: { swatches }, dispatch } = useAppContext()
  const { style, opacity } = layer.params

  const paletteEmpty = swatches.length === 0

  return (
    <div className={styles.content}>
      {/* Style dropdown */}
      <div className={styles.row}>
        <span className={styles.label}>Dithering Style</span>
        <select
          className={styles.select}
          value={style}
          onChange={(e) =>
            dispatch({
              type: 'UPDATE_ADJUSTMENT_LAYER',
              payload: { ...layer, params: { ...layer.params, style: e.target.value as typeof style } },
            })
          }
        >
          <option value="bayer4">Bayer 4×4</option>
          <option value="bayer8">Bayer 8×8</option>
          <option value="floyd-steinberg">Floyd-Steinberg</option>
          <option value="sierra-lite">Sierra Lite</option>
        </select>
      </div>

      {/* Opacity slider */}
      <div className={styles.row}>
        <span className={styles.label}>Opacity</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0} max={100} step={1}
            value={opacity}
            style={{ '--pct': String(opacity / 100) } as React.CSSProperties}
            onChange={(e) =>
              dispatch({
                type: 'UPDATE_ADJUSTMENT_LAYER',
                payload: { ...layer, params: { ...layer.params, opacity: Number(e.target.value) } },
              })
            }
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0} max={100} step={1}
          value={opacity}
          onChange={(e) => {
            const v = e.target.valueAsNumber
            if (!isNaN(v))
              dispatch({
                type: 'UPDATE_ADJUSTMENT_LAYER',
                payload: { ...layer, params: { ...layer.params, opacity: Math.min(100, Math.max(0, Math.round(v))) } },
              })
          }}
        />
      </div>

      {/* Palette state note */}
      {paletteEmpty ? (
        <p className={styles.warning}>
          Palette is empty — add swatches to enable dithering.
        </p>
      ) : (
        <p className={styles.info}>
          This effect dithers to the document palette. Update the palette in the Swatches panel to change the target colors.
        </p>
      )}
    </div>
  )
}
```

**`ColorDitheringPanel.module.scss`:** reuse the `content`, `row`, `label`, `trackWrap`, `track`, `numInput` class names from `BrightnessContrastPanel.module.scss` as a style reference. Add `.warning` (amber/warning text colour) and `.info` (muted secondary text colour) classes.

---

### Step 10 — `ToolWindow.tsx`

Add `'color-dithering'` to `toolTitle()`:

```ts
case 'color-dithering': return 'Color Dithering'
```

Add a `ColorDitheringHeaderIcon` SVG component (e.g. a small 2×2 checkerboard grid suggesting a dithering pattern):

```tsx
const ColorDitheringHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
    <rect x="0" y="0" width="3" height="3" />
    <rect x="6" y="0" width="3" height="3" />
    <rect x="3" y="3" width="3" height="3" />
    <rect x="9" y="3" width="3" height="3" />
    <rect x="0" y="6" width="3" height="3" />
    <rect x="6" y="6" width="3" height="3" />
    <rect x="3" y="9" width="3" height="3" />
    <rect x="9" y="9" width="3" height="3" />
  </svg>
)
```

Add to the icon dispatch switch (in the function that returns header icons by type):

```ts
if (type === 'color-dithering') return <ColorDitheringHeaderIcon />
```

Add to the adjustment layer panel render branch:

```tsx
{adjLayer.adjustmentType === 'color-dithering' && (
  <ColorDitheringPanel
    layer={adjLayer as ColorDitheringAdjustmentLayer}
    parentLayerName={parentName}
  />
)}
```

Import `ColorDitheringPanel` from `'./adjustments/ColorDitheringPanel/ColorDitheringPanel'` and `ColorDitheringAdjustmentLayer` from `'@/types'`.

---

### Step 11 — Setup Wizard Modal (`src/ux/modals/ColorDitheringSetupModal/`)

**`ColorDitheringSetupModal.tsx`:**

```tsx
interface ColorDitheringSetupModalProps {
  open: boolean
  onClose: () => void
  onProceed: (addReduceColors: boolean) => void
  onOpenGeneratePalette: () => void
}

export function ColorDitheringSetupModal({
  open, onClose, onProceed, onOpenGeneratePalette,
}: ColorDitheringSetupModalProps): React.JSX.Element | null {
  const [addReduceColors, setAddReduceColors] = useState(false)

  const handleProceed = (): void => {
    onProceed(addReduceColors)
    setAddReduceColors(false)  // reset for next invocation
  }

  const handleClose = (): void => {
    setAddReduceColors(false)
    onClose()
  }

  return (
    <ModalDialog open={open} title="Color Dithering" onClose={handleClose}>
      <p className={styles.body}>
        Color Dithering quantizes colors to the document palette. For the best retro
        look, configure your palette in the Swatches panel first.{' '}
        <button className={styles.link} onClick={onOpenGeneratePalette}>
          Open Generate Palette…
        </button>
      </p>
      <label className={styles.checkRow}>
        <input
          type="checkbox"
          checked={addReduceColors}
          onChange={(e) => setAddReduceColors(e.target.checked)}
        />
        Also add a Reduce Colors adjustment layer (mapped to current palette)
      </label>
      <div className={styles.actions}>
        <DialogButton variant="secondary" onClick={handleClose}>Cancel</DialogButton>
        <DialogButton variant="primary" onClick={handleProceed}>
          Proceed — Apply Color Dithering
        </DialogButton>
      </div>
    </ModalDialog>
  )
}
```

---

### Step 12 — App.tsx Integration

Add state variable near the other modal flags:

```ts
const [showColorDitheringWizard, setShowColorDitheringWizard] = useState(false)
```

Intercept the menu action in the `adj:` branch of `macMenuHandlerRef`:

```ts
if (actionId.startsWith('adj:')) {
  const type = actionId.slice(4) as AdjustmentType
  if (type === 'color-dithering') {
    requireTransformDecision(() => setShowColorDitheringWizard(true))
    return
  }
  requireTransformDecision(() => adjustments.handleCreateAdjustmentLayer(type))
  return
}
```

Define the wizard proceed handler (this is thin orchestration — real logic is in `useAdjustments`):

```ts
const handleColorDitheringProceed = useCallback((addReduceColors: boolean): void => {
  setShowColorDitheringWizard(false)
  adjustments.handleCreateColorDitheringLayers(addReduceColors)
}, [adjustments])
```

Render the modal in the JSX (must be rendered **before** `GeneratePaletteDialog` so that `GeneratePaletteDialog` stacks on top when both are open):

```tsx
<ColorDitheringSetupModal
  open={showColorDitheringWizard}
  onClose={() => setShowColorDitheringWizard(false)}
  onProceed={handleColorDitheringProceed}
  onOpenGeneratePalette={() => setShowGeneratePaletteDialog(true)}
/>
```

**Concurrent modal stacking:** `showColorDitheringWizard` and `showGeneratePaletteDialog` are independent. Clicking "Open Generate Palette…" sets `showGeneratePaletteDialog = true` without touching `showColorDitheringWizard`. When `GeneratePaletteDialog` closes, the wizard is still visible. `GeneratePaletteDialog` must appear later in the JSX (or have a higher CSS z-index) to render on top of the wizard's backdrop.

---

### Step 13 — `src/ux/index.ts`

Export the two new components:

```ts
export { ColorDitheringPanel } from './windows/adjustments/ColorDitheringPanel/ColorDitheringPanel'
export { ColorDitheringSetupModal } from './modals/ColorDitheringSetupModal/ColorDitheringSetupModal'
```

---

## Palette Access Design: Why a Storage Buffer

The palette is passed to the GPU as a `GPUBuffer` storage buffer (`read-only storage`, `array<vec4f, 256>`, 4096 bytes), rebuilt each frame in `canvasPlan.ts`. This is the same mechanism already used by `encodeReduceColorsPass` and requires no new GPU infrastructure. An alternative — a 1D `GPUTexture` (256×1 `rgba8unorm`) — would require a `GPUSampler` binding and provides no benefit over a storage buffer for a small indexed lookup with no filtering. Uniform array `var<uniform> palette: array<vec4f, 256>` is ruled out because WebGPU uniform buffer arrays must be padded to `vec4f` stride per element (which 256 × vec4f already is at 4096 bytes) — the storage buffer path is identical in byte layout but does not share the 64 KB uniform buffer size limit, giving more headroom if the palette ever grows.

---

## Error Diffusion: Algorithm Choice Rationale

The three candidate GPU approaches for error diffusion are rejected as follows:

| Approach | Problem |
|----------|---------|
| Per-pixel parallel GPU dispatch | Each pixel depends on left neighbor (same row) and up to two pixels from the previous row. True data dependency → cannot parallelize. |
| Row-by-row sequential GPU dispatches | Would require one `device.queue.submit()` per scanline (up to 4096+ submissions for a tall canvas). GPU submission overhead makes this 10–100× slower than WASM. |
| GPU approximation with fixed kernel | Would violate the spec's requirement for the canonical Floyd-Steinberg and Sierra Lite kernels, and the determinism guarantee. |

WASM is the correct choice. The `AGENTS.md` explicitly lists "dithering" as a WASM operation. The async cache approach means the expensive computation runs only when parameters actually change, not every frame — at Opacity = 100% with no param changes, the cached texture is reused indefinitely with zero CPU overhead.

---

## Rasterization Pipeline

`GpuRasterPipeline` calls `renderer.readFlattenedPlan()`, which internally calls `AdjustmentEncoder.encode()` for every adjustment op in the plan. Because `encode()` now handles `'color-dithering'` (Step 7), flatten/merge/export automatically includes the dithering effect.

**Exception: error-diffusion styles during rasterization.** If the `AdjustmentEncoder` cache is stale at the time `rasterizeWithGpu()` is called (e.g. on first export, or after a palette change that hasn't triggered a re-render yet), the encoder will write a passthrough to dstTex and schedule a background refresh — but since rasterization is a one-shot operation, that background result will never be used. The rasterization pipeline must therefore **await the cache being valid** before encoding for error-diffusion layers.

The recommended fix: expose a `prepareDithering(ops: AdjustmentRenderOp[]): Promise<void>` method on `AdjustmentEncoder` (or `WebGPURenderer`) that, for each error-diffusion dithering op in the plan, checks the cache and awaits `scheduleErrorDiffusion()` if needed. `GpuRasterPipeline` calls this before encoding the plan. This is the only async preparation step — Bayer dithering and all other adjustment types remain fully synchronous.

---

## Architectural Constraints

1. **`App.tsx` is a thin orchestrator.** The wizard proceed logic (computing `effectiveParentId`, building layer objects, dispatching) lives in `useAdjustments.handleCreateColorDitheringLayers`, not inline in `App.tsx`. App.tsx only holds the `showColorDitheringWizard` boolean and calls the hook method.

2. **Storage buffer pattern.** The palette storage buffer follows the established `createStorageBuffer` + `device.queue.writeBuffer` + `pendingDestroyBuffers.push()` pattern from `encodeReduceColorsPass` exactly. No new GPU buffer management utilities are needed.

3. **Single entry point for rasterization.** No separate compositing path is added for flatten/export/merge. The unified rasterization pipeline picks up the new op automatically through `AdjustmentEncoder.encode()`.

4. **WASM for sequential CPU-bound operations.** Per `AGENTS.md`, dithering is an explicitly named WASM candidate. The error-diffusion WASM module is new C++ code under `wasm/src/dithering.cpp`, not an inline JS implementation.

5. **Shader color space consistency.** Both the Bayer GPU shader and WASM error-diffusion use Euclidean sRGB byte-space nearest-color lookup. If either were to be upgraded to Oklab, both must change together to keep Bayer and error-diffusion outputs visually comparable when the user switches style.

6. **Panel category.** `ColorDitheringPanel` is a `ux/windows/` component — it is permitted to access `AppContext` directly. `ColorDitheringSetupModal` is a `ux/modals/` component — it wraps `ModalDialog` and has no knowledge of the layer stack; all dispatch is handled by the caller.

7. **Wizard shown once per menu invocation.** The `showColorDitheringWizard` state is only set to `true` by the `adj:color-dithering` menu action, never by `handleOpenAdjustmentPanel`. Re-opening an existing Color Dithering layer via the Layer Panel does not show the wizard.

8. **`onDitherCacheReady` stability.** The callback passed to `AdjustmentEncoder` must be a stable reference (not recreated on every render call). Bind it once in `WebGPURenderer`'s constructor or use a method reference.

---

## Open Questions

1. **Bayer threshold scale factor.** The formula `(t − 0.5) × 255.0` is used in the shader draft. Some implementations scale by `255 / N²` (the step size between palette colors for a linear ramp). Validate the chosen formula against a reference implementation on a gradient image to confirm the expected dithering density.

2. **Oklab upgrade path.** Both the GPU Bayer path and WASM error-diffusion use sRGB Euclidean distance. If perceptual quality needs improvement (especially for palettes with high luminance variation), upgrading to Oklab is straightforward — the `canvasPlan.ts` conversion exists in the `reduce-colors` case as a reference. This is deferred and not a blocker.

3. **`ADD_ADJUSTMENT_LAYER` insertion order.** The `handleCreateColorDitheringLayers` implementation assumes dispatching reduce-colors first inserts it before color-dithering in the layers array (so it composites first). Verify that the `ADD_ADJUSTMENT_LAYER` reducer appends to the end of the `layers` array and does not insert at a fixed position relative to the parent.

4. **Error-diffusion during rasterization — `prepareDithering()` call site.** Confirm where `prepareDithering()` should be called in the rasterization pipeline. `rasterizeWithGpu()` currently calls `renderer.readFlattenedPlan(plan)` — the prepare step should occur before this call. Since `rasterizeWithGpu` is already `async`, adding an `await encoder.prepareDithering(allDitheringOps)` call is straightforward once the method is defined.

5. **Multiple concurrent error-diffusion layers.** The design handles one pending refresh per layer ID via `pendingDitherRefresh`. If a document has two separate Color Dithering layers both with error-diffusion styles, each gets its own independent cache entry and refresh. Confirm this is correct and there is no resource contention.

6. **`AdjustmentEncoder` constructor call site.** `WebGPURenderer` constructs `AdjustmentEncoder` at line 169 of `WebGPURenderer.ts`. The new `onDitherCacheReady` parameter must be wired to a method that triggers a canvas re-render. Identify the correct callback — if `WebGPURenderer` exposes a `requestRender()` or similar method, use it; otherwise the callback must be passed in from `Canvas.tsx` at the point where `WebGPURenderer` is created.
