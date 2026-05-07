# Technical Design: Pixel Format Abstraction

## Overview

This feature makes the pixel format a first-class, document-wide property with three values: **`rgba8`** (existing default, unchanged), **`rgba32f`** (32-bit float per channel; internal format is always FP32, never FP16), and **`indexed8`** (one byte per pixel storing a palette index). The discriminant lives in `AppState` and travels with tabs through `TabSnapshot`. It drives WebGPU texture formats, the `GpuLayer.data` typed-array type, the render plan (adjustment/filter ops are skipped entirely in `indexed8`), `.verve` serialization (version 5), the status bar label, the Image→Color Mode menu, and tool/menu gating.

**rgba32f in this spec means FP32 (32 bits per channel) end-to-end internally.** FP16 is out of scope for internal use; it only appears at export (e.g. DDS BC6H), which is a separate follow-on feature.

---

## Affected Areas

| File | Change summary |
|---|---|
| `src/types/index.ts` | Add `PixelFormat` type; add `pixelFormat` to `AppState` |
| `src/graphics/webgpu/types.ts` | `GpuLayer.data` → `Uint8Array \| Float32Array`; add `format: PixelFormat` to `GpuLayer` |
| `src/core/store/AppContext.tsx` | Add `SET_PIXEL_FORMAT` action; thread `pixelFormat` through canvas-resetting actions |
| `src/core/store/tabTypes.ts` | Add `pixelFormat: PixelFormat` to `TabSnapshot` and `TabRecord` |
| `src/graphics/webgpu/utils.ts` | `uploadTextureData` / `uploadTexturePatch` accept `ArrayBufferView`; add `uploadF32TextureData` |
| `src/graphics/webgpu/rendering/WebGPURenderer.ts` | Format-aware `create()`, `createLayer()`, `flushLayer()`, ping-pong textures, composite pipeline |
| `src/graphics/webgpu/AdjustmentEncoder.ts` | `rgba32float` pipeline variants; format parameter on `encode()` |
| `src/graphics/webgpu/compute/filterCompute.ts` | `rgba32float` pipeline variants; format parameter on `run*` dispatch |
| `src/graphics/webgpu/shaders/` | Adjustment and filter WGSL shaders need `rgba32float` storage variants |
| `src/graphics/rasterization/types.ts` | `RasterizeDocumentResult.data` → `Uint8Array \| Float32Array` |
| `src/graphics/rasterization/GpuRasterPipeline.ts` | Return typed array from `readFlattenedPlan` |
| `src/ux/main/Canvas/canvasPlan.ts` | Skip adjustment ops when `pixelFormat === 'indexed8'` |
| `src/core/services/useFileOps.ts` | Version-5 save/load; format-aware pixel-data serialization/deserialization |
| `src/core/services/useExportOps.ts` | Clamp `Float32Array` → `Uint8Array` before encoding when document is `rgba32f` |
| `src/ux/main/StatusBar/StatusBar.tsx` | Dynamic format label from `AppState.pixelFormat` |
| `src/App.tsx` | Image→Color Mode menu; Adjustments/Effects/Filters menu gating; disabled tool set in `indexed8`; new dialog state |
| `src/ux/modals/ConvertColorModeDialog/` | **New.** Confirmation dialog for format conversion |
| `src/core/services/useColorMode.ts` | **New.** Business logic for confirming and executing format conversion |
| `src/utils/pixelFormatConvert.ts` | **New.** Pure-TS conversion helpers for all format pairs |
| `wasm/src/paletteMatch.cpp` (or `pixelops.cpp`) | **New C++ function.** Nearest-palette-index mapping for rgba8→indexed8 |
| `src/wasm/types.ts` | New WASM signature for palette-match function |
| `src/wasm/index.ts` | New high-level wrapper `matchPaletteIndices()` |
| `src/ux/index.ts` | Export `ConvertColorModeDialog` |

---

## State Changes

### `src/types/index.ts`

Add the `PixelFormat` discriminant immediately before the `AppState` interface:

```ts
export type PixelFormat = 'rgba8' | 'rgba32f' | 'indexed8'
```

Add `pixelFormat` to `AppState`:

```ts
export interface AppState {
  // ...existing fields unchanged...
  pixelFormat: PixelFormat   // new — defaults to 'rgba8'
}
```

### `src/graphics/webgpu/types.ts`

Update `GpuLayer`:

```ts
import type { PixelFormat } from '@/types'

export interface GpuLayer {
  id: string
  name: string
  texture: GPUTexture
  /** rgba8/indexed8 → Uint8Array; rgba32f → Float32Array */
  data: Uint8Array | Float32Array
  /** Pixel format for this layer — must match the document-wide format. */
  format: PixelFormat
  layerWidth: number
  layerHeight: number
  offsetX: number
  offsetY: number
  opacity: number
  visible: boolean
  blendMode: string
  dirtyRect: { lx: number; ly: number; rx: number; ry: number } | null
  contentVersion: number
}
```

Buffer sizes by format:
- `rgba8`: `Uint8Array(layerWidth × layerHeight × 4)`
- `rgba32f`: `Float32Array(layerWidth × layerHeight × 4)` — 4 float channels, values in [0,1] for SDR, unbounded for HDR
- `indexed8`: `Uint8Array(layerWidth × layerHeight × 1)` — each byte is a palette index

### `src/core/store/tabTypes.ts`

```ts
export interface TabSnapshot {
  // ...existing fields...
  pixelFormat: PixelFormat   // new — default 'rgba8'
}

export interface TabRecord {
  // ...existing fields...
  pixelFormat: PixelFormat   // new — default 'rgba8'
}

// Update INITIAL_SNAPSHOT:
export const INITIAL_SNAPSHOT: TabSnapshot = {
  // ...
  pixelFormat: 'rgba8',
}
```

`savedLayerData: Map<string, string>` values are format-dependent:
- `rgba8`: base64 PNG data URL (unchanged)
- `rgba32f`: base64-encoded raw `Float32Array` bytes (little-endian IEEE 754), prefixed with `data:raw/f32;base64,`
- `indexed8`: base64-encoded raw `Uint8Array` bytes, prefixed with `data:raw/indexed8;base64,`

The prefix scheme lets deserialization infer the encoding without needing a separate map.

### `src/core/store/AppContext.tsx`

**New action:**

```ts
| { type: 'SET_PIXEL_FORMAT'; payload: PixelFormat }
```

**Reducer case:**

```ts
case 'SET_PIXEL_FORMAT':
  return { ...state, pixelFormat: action.payload }
```

**Initial state:**

```ts
const initialState: AppState = {
  // ...existing fields...
  pixelFormat: 'rgba8',
}
```

**Canvas-resetting actions** (`NEW_CANVAS`, `OPEN_FILE`, `RESTORE_TAB`, `SWITCH_TAB`) must accept and propagate `pixelFormat` in their payloads so that switching tabs restores the correct format. Add `pixelFormat: PixelFormat` to each payload type and set `state.pixelFormat` accordingly in each case.

---

## New Components / Hooks / Tools

### `src/ux/modals/ConvertColorModeDialog/ConvertColorModeDialog.tsx`

**Category:** Modal (wraps `ModalDialog`)  
**Responsibility:** Present the format-conversion confirmation dialog. Shows the target format name, a general note about conversion, and format-specific warnings (HDR clamp warning for `rgba32f → *`, adjustment-suspension warning for `* → indexed8`). Has **Convert** and **Cancel** buttons.

**Props:**

```ts
interface ConvertColorModeDialogProps {
  fromFormat: PixelFormat
  toFormat: PixelFormat
  onConfirm: () => void
  onCancel: () => void
}
```

Derives the warning text from `(fromFormat, toFormat)`:
- `fromFormat === 'rgba32f' && toFormat !== 'rgba32f'` → append HDR clamp note
- `toFormat === 'indexed8'` → append adjustment-suspension note

### `src/core/services/useColorMode.ts`

**Category:** Hook  
**Responsibility:** Owns all business logic for changing the document pixel format. Exposes `handleConvertColorMode(toFormat)`.

**Inputs:** `canvasHandleRef`, `state: AppState`, `dispatch`.

**Logic flow for `handleConvertColorMode(toFormat)`:**

1. If `toFormat === state.pixelFormat`, no-op.
2. If `toFormat === 'indexed8'` and `state.swatches.length === 0`, show error and return.
3. Set `pendingConversion` state → renders `ConvertColorModeDialog`.
4. On `onCancel`, clear `pendingConversion`.
5. On `onConfirm`:
   a. Snapshot all `GpuLayer.data` for undo (use `historyStore` — one entry covering all layers).
   b. For each raster layer, call the appropriate conversion from `pixelFormatConvert.ts` / WASM.
   c. Re-upload each converted layer to GPU via `renderer.replaceLayerData(layer, newData, newFormat)` (see WebGPURenderer changes below).
   d. `dispatch({ type: 'SET_PIXEL_FORMAT', payload: toFormat })`.
   e. If `toFormat === 'rgba32f'` or converting **away** from `rgba32f`, increment `canvasKey` via tab update to remount the Canvas with the correct renderer configuration.
   f. Record undo.

> **Note on canvas remount:** Because the WebGPURenderer is constructed with a fixed internal texture format (see below), any change involving `rgba32f` (entering or leaving) must trigger a Canvas remount. The conversion hook achieves this by calling a `onFormatChangeRequiresRemount()` callback supplied by `App.tsx`, which increments the active tab's `canvasKey`. For `rgba8 ↔ indexed8` transitions, no remount is needed because both use `rgba8unorm` internally; the renderer can swap layer textures in place.

### `src/utils/pixelFormatConvert.ts`

**Category:** Utility (pure TS, no React)  
**Responsibility:** CPU-side pixel buffer conversions for all six format-pair transitions. Used by `useColorMode`.

```ts
// rgba8 → rgba32f: divide each uint8 by 255.0
convertRgba8ToF32(src: Uint8Array): Float32Array

// rgba32f → rgba8: clamp to [0,1], multiply by 255, round
convertF32ToRgba8(src: Float32Array): Uint8Array

// indexed8 → rgba8: expand each index via palette lookup
convertIndexedToRgba8(src: Uint8Array, palette: RGBAColor[]): Uint8Array

// rgba8 → indexed8: nearest-palette match — delegates to WASM
// Returns Uint8Array of palette indices; 255 for palette-empty pixels
convertRgba8ToIndexed(
  src: Uint8Array,
  w: number,
  h: number,
  palette: RGBAColor[],
): Promise<Uint8Array>

// rgba32f → indexed8: clamp→rgba8 then palette-match
convertF32ToIndexed(
  src: Float32Array,
  w: number,
  h: number,
  palette: RGBAColor[],
): Promise<Uint8Array>

// indexed8 → rgba32f: expand to rgba8 then normalize
convertIndexedToF32(src: Uint8Array, palette: RGBAColor[]): Float32Array
```

**Layer mask handling:** Layer masks are always `rgba8` (single-channel grayscale stored in the R channel of an RGBA buffer). They are never `rgba32f` or `indexed8`. Conversion does not touch mask data.

---

## WebGPURenderer Changes

### Factory: `WebGPURenderer.create()`

Accept a `pixelFormat` parameter:

```ts
static async create(
  canvas: HTMLCanvasElement,
  pixelWidth: number,
  pixelHeight: number,
  pixelFormat: PixelFormat = 'rgba8',
): Promise<WebGPURenderer>
```

The internal texture format is determined once at construction:

```ts
// rgba8 and indexed8 both use rgba8unorm internally
// (indexed8 layers are expanded to RGBA before upload)
const internalFormat: GPUTextureFormat =
  pixelFormat === 'rgba32f' ? 'rgba32float' : 'rgba8unorm'
```

Store `internalFormat` as a private field. Use it for ping-pong texture creation and the composite pipeline target.

### Ping-pong textures

Change `createPingPongTex()` to use `this.internalFormat`:

```ts
private createPingPongTex(w: number, h: number, usage: GPUTextureUsageFlags): GPUTexture {
  return this.device.createTexture({
    size: { width: w, height: h },
    format: this.internalFormat,  // was hardcoded 'rgba8unorm'
    usage,
  })
}
```

The composite pipeline must also target `this.internalFormat`.

### `createLayer()`

Add `format: PixelFormat` parameter:

```ts
createLayer(
  id: string,
  name: string,
  lw = this.pixelWidth,
  lh = this.pixelHeight,
  ox = 0,
  oy = 0,
  format: PixelFormat = 'rgba8',
): GpuLayer {
  const data: Uint8Array | Float32Array =
    format === 'rgba32f'
      ? new Float32Array(lw * lh * 4)
      : format === 'indexed8'
        ? new Uint8Array(lw * lh)          // 1 byte/pixel
        : new Uint8Array(lw * lh * 4)      // existing rgba8

  const textureFormat: GPUTextureFormat =
    format === 'rgba32f' ? 'rgba32float' : 'rgba8unorm'
    // indexed8 layers use rgba8unorm — flushLayer expands indices before upload

  const texture = createGpuTexture(this.device, lw, lh, null, textureFormat)
  return {
    id, name, texture, data, format,
    layerWidth: lw, layerHeight: lh,
    offsetX: ox, offsetY: oy,
    opacity: 1, visible: true, blendMode: 'normal',
    dirtyRect: null, contentVersion: 0,
  }
}
```

### `flushLayer()`

Add an optional `palette` parameter (required only for `indexed8`):

```ts
flushLayer(layer: GpuLayer, palette?: RGBAColor[]): void {
  if (this.deferFlush) return
  layer.contentVersion++

  if (layer.format === 'indexed8') {
    // Expand indices to RGBA8 using palette, then upload
    const expanded = expandIndicesToRgba8(layer.data as Uint8Array, palette ?? [])
    uploadTextureData(this.device, layer.texture, layer.layerWidth, layer.layerHeight, expanded)
    return
  }

  if (layer.format === 'rgba32f') {
    if (layer.dirtyRect) {
      uploadF32TexturePatch(this.device, layer.texture, layer.layerWidth, /* dirty rect */ ...)
    } else {
      uploadF32TextureData(this.device, layer.texture, layer.layerWidth, layer.layerHeight, layer.data as Float32Array)
    }
    layer.dirtyRect = null
    return
  }

  // rgba8 — unchanged existing path
  if (layer.dirtyRect) {
    const { lx, ly, rx, ry } = layer.dirtyRect
    layer.dirtyRect = null
    uploadTexturePatch(this.device, layer.texture, layer.layerWidth, lx, ly, rx - lx, ry - ly, layer.data as Uint8Array)
  } else {
    uploadTextureData(this.device, layer.texture, layer.layerWidth, layer.layerHeight, layer.data as Uint8Array)
  }
}
```

`expandIndicesToRgba8` is a private renderer helper (or imported from `pixelFormatConvert.ts`) that iterates indices and looks up each in `palette`, outputting RGBA8. Index values that exceed `palette.length` emit `[0, 0, 0, 0]`.

### `replaceLayerData()` — new method

Used by `useColorMode` to swap a layer's pixel buffer and GPU texture after conversion without destroying the layer object:

```ts
replaceLayerData(
  layer: GpuLayer,
  newData: Uint8Array | Float32Array,
  newFormat: PixelFormat,
  palette?: RGBAColor[],
): void {
  layer.texture.destroy()
  const textureFormat: GPUTextureFormat =
    newFormat === 'rgba32f' ? 'rgba32float' : 'rgba8unorm'
  layer.texture = createGpuTexture(this.device, layer.layerWidth, layer.layerHeight, null, textureFormat)
  layer.data = newData
  layer.format = newFormat
  layer.dirtyRect = null
  this.flushLayer(layer, palette)
}
```

### `readLayerPixels()` return type

```ts
readLayerPixels(layer: GpuLayer): Uint8Array | Float32Array {
  return layer.data.slice() as Uint8Array | Float32Array
}
```

Callers that type-narrow to `Uint8Array` must be updated (grep for `readLayerPixels` usages).

### `readFlattenedPlan()` return type

The composite result is in `this.internalFormat`. For `rgba32f`, the readback is 16 bytes/pixel (float). The method must return `Float32Array` in that case:

```ts
async readFlattenedPlan(plan: RenderPlanEntry[]): Promise<Uint8Array | Float32Array> {
  const { device, pixelWidth: w, pixelHeight: h } = this
  const encoder = device.createCommandEncoder()
  const finalTex = this.encodePlanToComposite(encoder, plan)

  const bytesPerPixel = this.internalFormat === 'rgba32float' ? 16 : 4
  const alignedBpr = Math.ceil(w * bytesPerPixel / 256) * 256
  const readbuf = createReadbackBuffer(device, alignedBpr * h)
  encoder.copyTextureToBuffer(
    { texture: finalTex },
    { buffer: readbuf, bytesPerRow: alignedBpr, rowsPerImage: h },
    { width: w, height: h },
  )
  device.queue.submit([encoder.finish()])
  this.flushPendingDestroys()

  await readbuf.mapAsync(GPUMapMode.READ)
  const raw = readbuf.getMappedRange()
  const result = this.internalFormat === 'rgba32float'
    ? this.unpackF32Rows(new Float32Array(raw), w, h, alignedBpr / 4)
    : this.unpackRows(new Uint8Array(raw), w, h, alignedBpr)
  readbuf.unmap()
  readbuf.destroy()
  return result
}
```

---

## AdjustmentEncoder / filterCompute: Format Support

### `indexed8` gating (plan level — no shader changes needed)

Adjustment and filter ops are skipped at the **plan-building** level in `canvasPlan.ts` when `pixelFormat === 'indexed8'`. The `AdjustmentEncoder` and `filterCompute` never receive adjustment ops for indexed documents. No format guard is needed inside those modules beyond the plan-level skip.

### `rgba32f` shader support

Adjustments and filters use the **unified render-attachment approach**: each pass is a render pass (fullscreen-quad vertex shader + fragment shader) rather than a compute dispatch. Shaders read from a `texture_2d<f32>` binding via a non-filtering sampler and write through a standard `@location(0) vec4<f32>` fragment output — no `texture_storage_2d` storage annotations are used.

Because the WGSL source encodes no texture format, the same shader source compiles into both format-specific render pipelines. The output format is declared at **pipeline creation time** via the `colorFormats` array:

```ts
// At AdjustmentEncoder construction — two GPURenderPipeline objects per adjustment type:
const pipelineRgba8   = device.createRenderPipeline({ ..., fragment: { targets: [{ format: 'rgba8unorm' }] } })
const pipelineRgba32f = device.createRenderPipeline({ ..., fragment: { targets: [{ format: 'rgba32float' }] } })
```

The WGSL shader source is identical for both. `encode()` selects which pipeline to use based on the `format` parameter:

- `format === 'rgba8unorm'`  → use the `rgba8unorm` render pipeline
- `format === 'rgba32float'` → use the `rgba32float` render pipeline

Two `GPURenderPipeline` objects per adjustment type are still required because `colorFormats` is fixed at pipeline creation time in WebGPU, but the WGSL shader source is not duplicated. This avoids doubling the shader count while keeping pipeline selection straightforward.

**`AdjustmentEncoder.encode()` signature change:**

```ts
encode(
  encoder: GPUCommandEncoder,
  op: AdjustmentRenderOp,
  srcTex: GPUTexture,
  dstTex: GPUTexture,
  format: GPUTextureFormat,  // new — selects the rgba8unorm or rgba32float render pipeline
): void
```

**`filterCompute` `run*` functions** receive the same `format` parameter and select the correct render pipeline.

The renderer passes `this.internalFormat` when calling both.

---

## Compositor / Render Plan: `indexed8` Palette Expansion Path

Palette expansion for `indexed8` layers happens in `flushLayer()` on the CPU before GPU upload. The GPU texture for an `indexed8` layer always contains the expanded `rgba8unorm` RGBA pixels. The compositor (render plan) never sees raw index data — it sees a normal `rgba8unorm` texture identical in structure to a `rgba8` layer texture.

**Consequence:** No changes are needed in the composite shader or `encodePlanToComposite`. The compositor is format-agnostic for `indexed8` because `flushLayer` handles the expansion.

**Palette invalidation:** When the swatch palette changes (any `ADD_SWATCH`, `REMOVE_SWATCH`, `SET_SWATCHES`, etc.), `indexed8` mode must re-upload all indexed layers. This is wired in `useCanvas` (or the Canvas component's effect that already watches `state.swatches`): iterate all GPU layers with `layer.format === 'indexed8'` and call `renderer.flushLayer(layer, state.swatches)`.

### `canvasPlan.ts` changes

At the point where `AdjustmentLayerState` entries are mapped to `AdjustmentRenderOp` via `buildAdjustmentEntry()`, add a format guard:

```ts
// canvasPlan.ts — in the plan-building loop
if (pixelFormat === 'indexed8' && adjustmentLayer.type === 'adjustment') {
  // Skip — adjustment layers are non-operational in indexed8 mode
  continue
}
```

`canvasPlan.ts` receives `pixelFormat` as a new parameter (from `Canvas.tsx` which reads `state.pixelFormat`).

---

## Conversion Logic

All conversions run on the CPU before GPU re-upload. The GPU is not involved in the conversion step itself.

| From | To | Where |
|---|---|---|
| `rgba8 → rgba32f` | Divide each uint8 by 255.0 | Pure TS in `pixelFormatConvert.ts` |
| `rgba32f → rgba8` | Clamp to [0,1], `Math.round(f * 255)` | Pure TS in `pixelFormatConvert.ts` |
| `rgba8 → indexed8` | Nearest palette entry by Euclidean RGBA distance | WASM (`matchPaletteIndices`) |
| `indexed8 → rgba8` | Index lookup in palette | Pure TS in `pixelFormatConvert.ts` |
| `rgba32f → indexed8` | Clamp→rgba8, then palette-match | TS clamp step + WASM match step |
| `indexed8 → rgba32f` | Expand to rgba8, then divide by 255.0 | Pure TS in `pixelFormatConvert.ts` |

### WASM: `matchPaletteIndices`

**C++ side (`wasm/src/pixelops.cpp`):**

```cpp
extern "C" EMSCRIPTEN_KEEPALIVE
void matchPaletteIndices(
  const uint8_t* rgba,          // input: width×height×4 RGBA8 bytes
  int           pixelCount,
  const uint8_t* palette,       // input: paletteSize×4 RGBA8 entries
  int           paletteSize,
  uint8_t*      out,            // output: pixelCount bytes of palette indices
  int           transparentIdx  // index to assign when palette is empty or input alpha==0
) { ... }
```

For each pixel, iterate the palette and find the index with minimum squared Euclidean distance in RGBA space. If `paletteSize == 0`, write `transparentIdx` for all pixels.

**Export symbol:** Append `_matchPaletteIndices` to `-sEXPORTED_FUNCTIONS` in `wasm/CMakeLists.txt`.

**TypeScript wrapper (`src/wasm/index.ts`):**

```ts
export async function matchPaletteIndices(
  rgba: Uint8Array,
  palette: RGBAColor[],
  transparentIdx = 255,
): Promise<Uint8Array>
```

Uses the standard `withInPlaceBuffer` pattern; re-reads `module.HEAPU8` after the call.

### Atomicity guarantee

If any single layer conversion throws (e.g. out-of-memory on `Float32Array` allocation), `useColorMode` must abort the entire operation and leave all layers in their pre-conversion state. Pre-allocate all output buffers for all layers before writing any of them back. Only dispatch `SET_PIXEL_FORMAT` and call `replaceLayerData()` after all buffers are successfully computed.

---

## `.verve` Serialization: Version 5

### Save path (`useFileOps.handleSave` / `handleSaveACopy`)

Bump `version` to `5`. Add `pixelFormat` as a top-level field. Layer data encoding is format-dependent:

```ts
const doc = {
  version: 5,
  pixelFormat: state.pixelFormat,
  canvas: { ... },
  activeLayerId: state.activeLayerId,
  layers: state.layers.map(l => {
    const base = {
      ...l,
      imageData: null as string | null,
      layerDataF32: null as string | null,
      layerDataIndexed: null as string | null,
      layerGeo: layerGeos[l.id] ?? null,
      adjustmentMaskPng: adjustmentMaskPngs[l.id] ?? null,
    }
    if (!isPixelLayer(l)) return base  // adjustment/text/shape/group — no pixel data

    if (state.pixelFormat === 'rgba8') {
      base.imageData = layerPngs[l.id] ?? null  // existing PNG export
    } else if (state.pixelFormat === 'rgba32f') {
      const f32 = canvasHandleRef.current?.exportLayerF32(l.id)
      if (f32) base.layerDataF32 = btoa(String.fromCharCode(...new Uint8Array(f32.buffer)))
    } else if (state.pixelFormat === 'indexed8') {
      const idx = canvasHandleRef.current?.exportLayerIndexed(l.id)
      if (idx) base.layerDataIndexed = btoa(String.fromCharCode(...new Uint8Array(idx.buffer)))
    }
    return base
  }),
  swatches: state.swatches,
  swatchGroups: state.swatchGroups,
  pixelBrushes: state.pixelBrushes,
}
```

**Canvas handle additions:** `exportLayerF32(layerId)` → `Float32Array` and `exportLayerIndexed(layerId)` → `Uint8Array` are new methods on `CanvasHandle` that return `layer.data` for the identified GPU layer. (The existing `exportLayerPng` uses `layer.data` via a 2D canvas; these new methods skip the PNG encoding.)

### Load path (`useFileOps.openFromPath`)

```ts
const pixelFormat: PixelFormat = (() => {
  if (doc.version < 5) return 'rgba8'  // backward compat
  const fmt = doc.pixelFormat
  if (fmt !== 'rgba8' && fmt !== 'rgba32f' && fmt !== 'indexed8') {
    showOperationError(
      'Could not open file.',
      'This document uses an unsupported pixel format and cannot be opened.',
    )
    return null  // abort
  }
  return fmt
})()
if (!pixelFormat) return
```

Then, when building `layerData: Map<string, string>`:

```ts
// Inside doc.layers.map():
if (pixelFormat === 'rgba8') {
  if (imageData) layerData.set(meta.id, imageData)             // unchanged
} else if (pixelFormat === 'rgba32f' && layerDataF32) {
  // Validate presence; abort if missing for a pixel layer
  layerData.set(meta.id, `data:raw/f32;base64,${layerDataF32}`)
} else if (pixelFormat === 'indexed8' && layerDataIndexed) {
  layerData.set(meta.id, `data:raw/indexed8;base64,${layerDataIndexed}`)
}
```

Include `pixelFormat` in the new `TabSnapshot` created for the loaded file.

The Canvas's `useEffect` that seeds GPU layers from `pendingLayerData` must be updated to decode format-prefixed entries: PNG data URLs are loaded via the existing `Image`/canvas path; `data:raw/f32;base64,...` entries are decoded directly to `Float32Array`; `data:raw/indexed8;base64,...` entries to `Uint8Array`.

### Version compatibility table (unchanged from spec)

| Version | `pixelFormat` field | Behavior on load |
|---|---|---|
| 1–4 | absent | Treat as `rgba8`; existing decode unchanged |
| 5 | `"rgba8"` | Normal; `imageData` fields decoded as today |
| 5 | `"rgba32f"` | `layerDataF32` decoded to `Float32Array` |
| 5 | `"indexed8"` | `layerDataIndexed` decoded to `Uint8Array` |
| 5 | unrecognized | Open aborted; error shown |

---

## UI Wiring

### Status bar (`src/ux/main/StatusBar/StatusBar.tsx`)

Replace the hardcoded `'RGB/8'` span with a dynamic label:

```tsx
const formatLabel = { rgba8: 'RGB/8', rgba32f: 'RGB/32F', indexed8: 'Indexed/8' }[state.pixelFormat]
// ...
<span className={styles.infoItem}>{formatLabel}</span>
```

### Image → Color Mode menu (`src/App.tsx`)

Add an **Image** menu to the `menus` array passed to `MenuBar`. Insert it between the Layer and Adjustments menus, per the AGENTS.md menu order note (currently: File → Edit → Select → Layer → Adjustments → …). The Image menu has one item: **Color Mode** with a submenu:

```ts
{
  label: 'Image',
  items: [
    {
      label: 'Color Mode',
      submenu: [
        {
          label: 'RGB/8',
          checked: state.pixelFormat === 'rgba8',
          action: () => colorMode.handleConvertColorMode('rgba8'),
        },
        {
          label: 'RGB/32 Float',
          checked: state.pixelFormat === 'rgba32f',
          action: () => colorMode.handleConvertColorMode('rgba32f'),
        },
        {
          label: 'Indexed/8',
          checked: state.pixelFormat === 'indexed8',
          action: () => colorMode.handleConvertColorMode('indexed8'),
        },
      ],
    },
  ],
}
```

`colorMode` is the return value of the new `useColorMode` hook, called in `AppContent`.

### Adjustments / Effects / Filters menu gating

Wrap each adjustment/effects/filter menu item with `disabled: state.pixelFormat === 'indexed8'`. The simplest approach: derive `adjDisabled = state.pixelFormat === 'indexed8'` and apply it to all items in those three menu sections via a helper that recursively marks items disabled.

### Tool gating for `indexed8`

In `App.tsx`, derive the set of tools disabled in `indexed8` mode:

```ts
const INDEXED8_DISABLED_TOOLS = new Set<Tool>(['brush', 'gradient', 'clone-stamp', 'dodge', 'burn'])
const toolDisabledInCurrentMode = (tool: Tool): boolean =>
  state.pixelFormat === 'indexed8' && INDEXED8_DISABLED_TOOLS.has(tool)
```

Pass this predicate to `Toolbar` (or derive it there from `AppContext`) to gray out disabled tools. If the active tool is in the disabled set when the format changes to `indexed8`, switch the active tool to `'pencil'` as part of the `SET_PIXEL_FORMAT` reducer case or in the `useColorMode` hook after dispatch.

### `ConvertColorModeDialog` mounting

In `AppContent`, add dialog state:

```ts
const [pendingConversion, setPendingConversion] = useState<PixelFormat | null>(null)
```

Mount the dialog when `pendingConversion !== null`:

```tsx
{pendingConversion !== null && (
  <ConvertColorModeDialog
    fromFormat={state.pixelFormat}
    toFormat={pendingConversion}
    onConfirm={() => { colorMode.executeConversion(pendingConversion); setPendingConversion(null) }}
    onCancel={() => setPendingConversion(null)}
  />
)}
```

`useColorMode.handleConvertColorMode(toFormat)` sets `pendingConversion` (via a callback from `App.tsx`) rather than managing dialog state itself, keeping dialog visibility in the App layer.

---

## `useExportOps` changes

`handle.rasterizeLayers()` now returns `Uint8Array | Float32Array`. Before passing to export functions, clamp if necessary:

```ts
const flat = await handle.rasterizeLayers(stateRef.current.layers, 'export')
const data: Uint8Array =
  flat.data instanceof Float32Array
    ? clampF32ToUint8(flat.data)  // from pixelFormatConvert.ts
    : flat.data
```

All existing export encoders (`exportPng`, `exportJpeg`, etc.) continue to accept `Uint8Array` unchanged.

---

## Implementation Steps

1. **`src/types/index.ts`** — Add `PixelFormat` type. Add `pixelFormat: PixelFormat` to `AppState`.

2. **`src/graphics/webgpu/types.ts`** — Update `GpuLayer`: `data: Uint8Array | Float32Array`, add `format: PixelFormat`.

3. **`src/core/store/tabTypes.ts`** — Add `pixelFormat: PixelFormat` to `TabSnapshot` and `TabRecord`. Update `INITIAL_SNAPSHOT`.

4. **`src/core/store/AppContext.tsx`** — Add `pixelFormat: 'rgba8'` to `initialState`. Add `SET_PIXEL_FORMAT` action and reducer case. Add `pixelFormat` to the payloads of `NEW_CANVAS`, `OPEN_FILE`, `RESTORE_TAB`, `SWITCH_TAB` and set `state.pixelFormat` in each case.

5. **`src/graphics/webgpu/utils.ts`** — Broaden `uploadTextureData` and `uploadTexturePatch` to accept `ArrayBufferView` instead of `Uint8Array`. Add `uploadF32TextureData` and `uploadF32TexturePatch` helpers that wrap `writeTexture` for `rgba32float` (bytesPerRow = `width * 16`).

6. **`src/graphics/webgpu/rendering/WebGPURenderer.ts`** — Add `pixelFormat` parameter to `create()`. Store `internalFormat`. Update `createPingPongTex` and the composite pipeline target. Update `createLayer()` to accept and store `format`. Update `flushLayer()` for all three format paths. Add `replaceLayerData()`. Update `readLayerPixels()` return type. Update `readFlattenedPlan()` return type and readback for `rgba32float`.

7. **`src/graphics/webgpu/AdjustmentEncoder.ts`** — Convert all adjustment passes from storage-texture compute dispatches to render passes (fullscreen-quad vertex + fragment shader). At construction, create two `GPURenderPipeline` objects per adjustment type — one with `colorFormats: ['rgba8unorm']` and one with `colorFormats: ['rgba32float']` — both compiled from the same WGSL shader source. Add `format: GPUTextureFormat` parameter to `encode()`; select the matching render pipeline based on the format.

8. **`src/graphics/webgpu/compute/filterCompute.ts`** — Apply the same render-attachment approach: replace storage-texture compute pipelines with render pipelines (fullscreen-quad vertex + fragment shader). Two `GPURenderPipeline` objects per filter type (one per format), identical WGSL source for both. Add `format: GPUTextureFormat` parameter to each `run*` dispatch function.

9. **`src/graphics/webgpu/shaders/`** — Rewrite all adjustment and filter WGSL shaders to use `texture_2d<f32>` + non-filtering sampler for input reads and `@location(0) vec4<f32>` fragment output for writes. Remove all `texture_storage_2d` declarations. The same shader source is compiled into both the `rgba8unorm` and `rgba32float` render pipelines — no per-format shader variants are needed.

10. **`src/graphics/rasterization/types.ts`** — `RasterizeDocumentResult.data: Uint8Array | Float32Array`.

11. **`src/graphics/rasterization/GpuRasterPipeline.ts`** — Return the typed array from `readFlattenedPlan` as-is (the renderer now returns the right type).

12. **`src/ux/main/Canvas/canvasPlan.ts`** — Accept `pixelFormat` parameter. Skip `AdjustmentRenderOp` entries when `pixelFormat === 'indexed8'`. Pass `format` (as `internalFormat`) to `AdjustmentEncoder.encode()` and filter dispatch calls.

13. **`wasm/src/pixelops.cpp`** — Add `matchPaletteIndices` C++ implementation.

14. **`wasm/CMakeLists.txt`** — Append `_matchPaletteIndices` to `-sEXPORTED_FUNCTIONS`.

15. **`src/wasm/types.ts`** — Add signature for `matchPaletteIndices`.

16. **`src/wasm/index.ts`** — Add `matchPaletteIndices()` wrapper.

17. **`src/utils/pixelFormatConvert.ts`** — Implement all six conversion functions (new file).

18. **`src/ux/modals/ConvertColorModeDialog/`** — Create dialog component and its `.module.scss`.

19. **`src/ux/index.ts`** — Export `ConvertColorModeDialog`.

20. **`src/core/services/useColorMode.ts`** — Implement conversion hook. Uses `pixelFormatConvert.ts`, `matchPaletteIndices` WASM wrapper, `renderer.replaceLayerData()`, and `dispatch(SET_PIXEL_FORMAT)`. Pre-allocates all output buffers before modifying any layer state.

21. **`src/core/services/useFileOps.ts`** — Version-5 save: emit `pixelFormat`, use `layerDataF32`/`layerDataIndexed` where appropriate. Version-5 load: validate `pixelFormat`, decode format-specific layer data, pass `pixelFormat` into the new `TabSnapshot`.

22. **`src/ux/main/StatusBar/StatusBar.tsx`** — Replace hardcoded `'RGB/8'` with dynamic format label from `state.pixelFormat`.

23. **`src/App.tsx`** — Wire `useColorMode`. Add Image→Color Mode menu. Gate Adjustments/Effects/Filters menus with `disabled` when `indexed8`. Apply tool-gating predicate. Add `pendingConversion` state and mount `ConvertColorModeDialog`. Switch active tool to `'pencil'` if the current tool is disabled in the newly selected format.

24. **`src/core/services/useExportOps.ts`** — Clamp `Float32Array` export output before passing to export encoders.

25. **`npm run build:wasm`** — Rebuild WASM after C++ changes.

26. **`npm run typecheck`** — Resolve all TypeScript errors. Pay particular attention to: all existing `layer.data` accesses (must type-narrow), all `readLayerPixels` callers, all `readFlattenedPlan`/`rasterizeDocument` result consumers.

---

## Architectural Constraints

- **`App.tsx` stays thin.** Business logic for the conversion (pre-allocating buffers, calling WASM, calling `replaceLayerData`, dispatching) lives entirely in `useColorMode`. `App.tsx` only manages `pendingConversion` dialog state and passes the hook return value to the menu.
- **No ad-hoc compositing.** All flatten/merge/export must continue to flow through `rasterizeDocument`. The format changes to `readFlattenedPlan` extend rather than bypass this pipeline.
- **WASM boundary.** Only `src/wasm/index.ts` imports from `src/wasm/generated/`. `matchPaletteIndices` is exposed through this wrapper only.
- **Pointer events.** Tool handlers read `layer.data` directly (it is typed `Uint8Array | Float32Array`). Each tool that reads pixel values must type-narrow based on `layer.format`. This is enforced at the `ToolContext` level — the `format` field on `GpuLayer` provides the runtime discriminant.
- **Module-level options objects.** Tool drawing options (e.g. `brushOptions`) are module-level singletons. No format state belongs in them; tools receive the format from `ToolContext.layer.format`.
- **CSS Modules.** `ConvertColorModeDialog.module.scss` (not plain `.scss`).
- **Palette expansion is always CPU-side in `flushLayer`.** The GPU compositor must not need any palette uniform buffer or special indexed-layer detection. The GPU always sees expanded RGBA.

---

## Open Questions

1. **Canvas remount on format change involving `rgba32f`.** The current design remounts the Canvas (increments `canvasKey`) whenever entering or leaving `rgba32f`. This resets GPU state and restores from `savedLayerData`. This is the same mechanism used for resize/crop. Confirm that `savedLayerData` serialization for rgba32f layers (steps 18–22 in useCanvas) is handled before the remount is triggered, otherwise the conversion data will be lost.

2. **`growLayerToFit()` and float pixel data.** This method reallocates `layer.data` as a new `Uint8Array` internally. It must be updated to reallocate as a `Float32Array` for `rgba32f` layers (and copy the old data with correct byte offsets). Audit `growLayerToFit` during step 6.

3. **Layer mask format.** Layer masks are always single-channel grayscale stored in the R channel of an RGBA8 buffer. They must remain `rgba8` regardless of document `pixelFormat`. Confirm that `createLayer` calls for mask layers always pass `format: 'rgba8'` explicitly, and that the conversion in `useColorMode` skips mask layers.

4. **`indexed8` eyedropper behavior.** The spec requires the eyedropper to sample the palette index of the clicked pixel and set the primary swatch to the corresponding palette color. This tool-level behavior is not covered by the foundation spec but must not be broken by the `GpuLayer.data` type change. The eyedropper currently reads from the flattened RGBA. In `indexed8` mode it should read `layer.data[pixelIndex]` (a byte index) and map to `state.swatches[index]`. Flag for the Indexed Color Mode follow-on spec.

5. **`savedLayerData` base64 encoding for large `rgba32f` layers.** `btoa(String.fromCharCode(...))` fails on buffers larger than ~65k elements due to call-stack limits. Use a chunked approach or `Buffer.from(...).toString('base64')` (available in Electron's renderer via the Node integration or a small Electron IPC helper) for `Float32Array` serialization. Resolve before step 21.
