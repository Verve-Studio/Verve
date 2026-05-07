# Technical Design: HDR FP32 Mode

## Overview

This document covers the implementation work that is **specific to the HDR FP32 editing experience** on top of the `rgba32f` pipeline infrastructure defined in the [Pixel Format Abstraction technical design](pixel-format-abstraction.md). That foundation provides: the `PixelFormat` discriminant in `AppState`, `GpuLayer.data` as `Float32Array`, `rgba32float` WebGPU textures, format-aware `flushLayer`/`createLayer`/`readFlattenedPlan`, dual render pipelines in `AdjustmentEncoder` and `filterCompute`, and `.verve` version-5 serialization.

This design adds the six remaining deliverables:

1. **Display tone-mapping system** — A generic, pluggable tone-mapping pipeline inserted in the final blit/display shader. The active operator and EV exposure are held in a module-level `displayStore` singleton. The shader dispatches on an `operator` uniform so new operators (e.g. ACEScg, Filmic, AgX) can be added without changing calling code. Bypassed for non-`rgba32f` documents and for all flatten/export/merge operations. V1 ships with **Reinhard** as the only operator; the architecture is designed to accommodate additional operators without structural change.
2. **Tone-mapping controls** — `ToneMappingControls` component rendered in the canvas toolbar. Hosts an operator selector dropdown (initially one entry: Reinhard) and an EV exposure slider. Both read/write `displayStore`. Visible only for `rgba32f` tabs.
3. **HDR-aware color picker** — Intensity multiplier field added to `EmbedColorPicker`, hidden for `rgba8`/`indexed8`; an `hdrIntensity` field added to `AppState` (Option B from the prompt, minimising churn on existing code).
4. **EXR file I/O** — tinyexr compiled to WASM; `loadExr`/`saveExr` WASM wrappers; updated `imageLoader` / `exportExr`.
5. **Radiance HDR file I/O** — pure-TypeScript RGBE encode/decode; `loadHdr`/`saveHdr`; updated `imageLoader` / `exportHdr`.
6. **32-bit float TIFF I/O** — extend the existing `utif` TIFF path to detect and read `SAMPLEFORMAT=3`; write path implemented as a custom TIFF writer (no WASM needed for baseline uncompressed float TIFF).

Eyedropper HDR indicator, status bar `RGB/32F` label with blue accent, pixel-info float readout, and LDR-format export tone-mapping warnings are also specified here as they depend on the tone-mapping infrastructure established in this document.

---

## Affected Areas

| File | Change summary |
|---|---|
| `src/graphics/webgpu/shaders/rendering/blit.ts` | Add `HDR_BLIT_SHADER` variant with pluggable operator dispatch (Reinhard V1; ACES stub ready for V2); existing `BLIT_SHADER` unchanged |
| `src/graphics/webgpu/rendering/WebGPURenderer.ts` | Create second blit pipeline using `HDR_BLIT_SHADER`; update 16-byte uniform buffer (`exposureLinear`, `isFp32`, `operator`, `_pad`) each frame; always uses HDR pipeline (branches internally on `isFp32`) |
| `src/core/store/displayStore.ts` | **New.** Module-level singleton holding `exposureEV` (default `0`) and `toneMappingOperator` (default `'reinhard'`); notify-subscribe pattern identical to `cursorStore` |
| `src/types/index.ts` | Add `ToneMappingOperator` union type |
| `src/types/index.ts` | Add `hdrIntensity: number` to `AppState` |
| `src/core/store/AppContext.tsx` | Add `SET_HDR_INTENSITY` action; reset `hdrIntensity` to `1.0` in canvas-resetting actions (`NEW_CANVAS`, `OPEN_FILE`, `RESTORE_TAB`, `SWITCH_TAB`) |
| `src/ux/widgets/EmbedColorPicker/EmbedColorPicker.tsx` | Add `isHdrMode` prop; render Intensity numeric field + float channel readout when `isHdrMode` is true; emit intensity-scaled float values via new `onChangeFloat` callback |
| `src/ux/main/Canvas/ToneMappingControls.tsx` | **New.** Operator selector dropdown + EV slider; reads/writes `displayStore.toneMappingOperator` and `displayStore.exposureEV`; re-renders via `displayStore` subscription; hidden for non-`rgba32f` documents |
| `src/ux/main/Canvas/ToneMappingControls.module.scss` | **New.** Styles for tone-mapping inline controls |
| `src/ux/main/Canvas/Canvas.tsx` | Mount `ToneMappingControls` inside the canvas wrapper; pass `pixelFormat` to `buildRenderPlan`; pass display-pass uniforms to renderer each frame |
| `src/ux/main/Canvas/canvasPlan.ts` | Receive and thread `pixelFormat` parameter (already required by Pixel Format Abstraction TD; confirmed wired here for HDR display path) |
| `src/ux/main/StatusBar/StatusBar.tsx` | Replace hardcoded `"RGB/8"` with dynamic label from `state.pixelFormat`; add blue accent class for `rgba32f`; show float pixel-info in `rgba32f` mode |
| `src/core/io/imageLoader.ts` | Add `.exr` and `.hdr` to `IMAGE_EXTENSIONS` and `EXT_TO_MIME`; detect EXR/HDR in `loadImagePixels`; add `loadHdrImagePixels` returning `{ data: Float32Array; width: number; height: number; isHdr: boolean }` |
| `src/core/io/exportExr.ts` | **New.** `exportExr(pixels, width, height, options)` → `Uint8Array` using WASM tinyexr encoder |
| `src/core/io/exportHdr.ts` | **New.** `exportHdr(pixels, width, height)` → `Uint8Array` using pure-TS RGBE encoder |
| `src/core/io/exportTiff32.ts` | **New.** `exportTiff32(pixels, width, height)` → `Uint8Array`; writes uncompressed 32-bit float TIFF (SAMPLEFORMAT=3) |
| `src/core/services/useExportOps.ts` | Handle `'exr'`, `'hdr'`, `'tiff32'` export format branches; add HDR-to-LDR tone-map warning dialog trigger for LDR formats when document is `rgba32f` |
| `src/core/services/useFileOps.ts` | Call `loadHdrImagePixels` for `.exr`/`.hdr` extensions; set `pixelFormat: 'rgba32f'` on the resulting tab; show toast on successful HDR open |
| `src/ux/modals/ExportDialog/ExportDialog.tsx` | Add EXR, HDR, TIFF32 format options (gated to `rgba32f` documents); EXR compression type selector |
| `src/ux/modals/HdrLdrExportWarningDialog/` | **New.** Confirmation dialog shown when exporting an `rgba32f` document to a standard LDR format |
| `src/ux/index.ts` | Export `EVSlider`, `HdrLdrExportWarningDialog` |
| `wasm/src/exr.cpp` | **New.** tinyexr wrapper: `loadExr` + `saveExr` `EMSCRIPTEN_KEEPALIVE` C functions |
| `wasm/src/tinyexr.h` | **New.** tinyexr single-header (pinned version) |
| `wasm/CMakeLists.txt` | Add `exr.cpp` to sources; add `_loadExr` and `_saveExr` to `EXPORTED_FUNCTIONS` |
| `src/wasm/types.ts` | Add `loadExr` and `saveExr` signatures to `PixelOpsModule` |
| `src/wasm/index.ts` | Add `decodeExr()` and `encodeExr()` high-level wrappers |

---

## State Changes

### `src/types/index.ts` — `ToneMappingOperator`

Add the operator union type. New operators are added here when implemented:

```ts
// Extensible union — add new operator literals here as they are implemented.
export type ToneMappingOperator =
  | 'reinhard'   // V1: per-channel Reinhard
  // | 'aces'    // V2 (planned): ACES approximate
  // | 'filmic'  // V3 (planned): Filmic/Hejl-Burgess-Dawson
```

The commented-out variants are placeholders to illustrate the extension pattern. They are activated by un-commenting and adding the corresponding WGSL branch + UI label.

### `src/types/index.ts` — `AppState`

Add `hdrIntensity` to `AppState` (Option B — separate field, not changing `primaryColor` type):

```ts
export interface AppState {
  // ...existing fields unchanged...
  hdrIntensity: number   // multiplier for HDR color picker; default 1.0; range [0.0, 16.0]
}
```

`hdrIntensity` is always present in `AppState` regardless of `pixelFormat`. Its value is only used (and the UI field only shown) when `pixelFormat === 'rgba32f'`.

### `src/core/store/AppContext.tsx`

**New action:**

```ts
| { type: 'SET_HDR_INTENSITY'; payload: number }
```

**Reducer case:**

```ts
case 'SET_HDR_INTENSITY':
  return { ...state, hdrIntensity: Math.max(0, Math.min(16, action.payload)) }
```

**Initial state:**

```ts
hdrIntensity: 1.0,
```

**Canvas-resetting actions** (`NEW_CANVAS`, `OPEN_FILE`, `RESTORE_TAB`, `SWITCH_TAB`): reset `hdrIntensity` to `1.0` in each case. This ensures the Intensity field resets when switching tabs, matching the per-session-per-tab EV behavior.

### `src/core/store/displayStore.ts` — new module-level singleton

Holds the per-session display-pass state. Both `exposureEV` and `toneMappingOperator` are consumed every frame by the display blit without going through React, so they live in a singleton (like `cursorStore`), not `AppState`.

`toneMappingOperator` is a **global** display preference (not per-tab). It persists across tab switches deliberately — users typically want to audition all their work under the same display transform.

```ts
import type { ToneMappingOperator } from '@/types'

class DisplayStore {
  exposureEV: number = 0
  toneMappingOperator: ToneMappingOperator = 'reinhard'

  private listeners = new Set<() => void>()
  subscribe(fn: () => void): void   { this.listeners.add(fn) }
  unsubscribe(fn: () => void): void { this.listeners.delete(fn) }
  notify(): void                    { for (const fn of this.listeners) fn() }

  setEV(ev: number): void {
    this.exposureEV = Math.max(-4, Math.min(4, ev))
    this.notify()
  }

  setOperator(op: ToneMappingOperator): void {
    this.toneMappingOperator = op
    this.notify()
  }

  /** Resets only EV; operator is a global preference and persists across tab switches. */
  reset(): void { this.setEV(0) }
}

export const displayStore = new DisplayStore()

/** Maps operator names to the u32 values expected by the WGSL shader. */
export const OPERATOR_SHADER_ID: Record<ToneMappingOperator, number> = {
  reinhard: 1,
  // aces: 2,   // uncomment when WGSL branch is added
}
```

**Tab switching:** `useTabs` calls `displayStore.reset()` when switching tabs (resets EV to 0). The operator is intentionally not reset.

---

## New Components / Hooks / Tools

### `src/ux/main/Canvas/ToneMappingControls.tsx`

**Category:** Main UX Framework (rendered inside the Canvas area)  
**Responsibility:** Display and mutate `displayStore.toneMappingOperator` and `displayStore.exposureEV`. Renders only when `pixelFormat === 'rgba32f'`.

**Props:**

```ts
interface ToneMappingControlsProps {
  pixelFormat: PixelFormat
}
```

**Behavior:**
- Subscribes to `displayStore` in a `useEffect` and re-renders when either EV or operator changes.
- Renders:
  1. An **Operator** `<select>` dropdown listing all entries in `OPERATOR_SHADER_ID` by display name (e.g. `"Reinhard"`). On change, calls `displayStore.setOperator(value)`.
  2. An **EV** label + range `<input>` (min=`-4`, max=`4`, step=`0.1`) + numeric `<input>` (value to one decimal, e.g. `+1.0`). On change, calls `displayStore.setEV(value)`.
- Numeric EV input: Tab/Enter commits; Escape reverts to the last committed value.
- Returns `null` when `pixelFormat !== 'rgba32f'` (hidden, not greyed out).
- Does **not** use React state for EV or operator — only reads from `displayStore`. Renders via a local `useState` that is set from the `displayStore` subscription.
- **Adding a new operator:** Add its `ToneMappingOperator` literal to `src/types/index.ts`, add it to `OPERATOR_SHADER_ID` in `displayStore.ts`, add a WGSL branch in `HDR_BLIT_SHADER`, and add its display label to the operator map in this component. No other files need to change.

**Placement:** Rendered inline inside `Canvas.tsx`'s toolbar area, adjacent to zoom controls. Passed `state.pixelFormat` from `Canvas.tsx`.

### `src/ux/modals/HdrLdrExportWarningDialog/HdrLdrExportWarningDialog.tsx`

**Category:** Modal (wraps `ModalDialog`)  
**Responsibility:** Warn the user that exporting an `rgba32f` document to an LDR format (PNG, JPEG, WebP, TGA, standard TIFF 8-bit) will apply the active tone-mapping operator at current EV settings. Show the target format name and the active operator name.

**Props:**

```ts
interface HdrLdrExportWarningDialogProps {
  targetFormat: string         // e.g. 'PNG', 'JPEG'
  toneMappingOperator: string  // e.g. 'Reinhard' — display name of the active operator
  onConfirm: () => void
  onCancel: () => void
}
```

---

## Implementation Steps

### Phase 1 — Display Tone-Mapping Shader

**Step 1 — `src/graphics/webgpu/shaders/rendering/blit.ts`**

Add `HDR_BLIT_SHADER` below the existing `BLIT_SHADER`. The uniform struct is extended with `operator: u32` to select the tone-mapping algorithm. New operators are added as additional `else if` branches in the fragment shader — no pipeline rebuild is required.

```ts
export const HDR_BLIT_SHADER = /* wgsl */ `
struct BlitRes {
  resolution  : vec2f,
  _pad        : vec2f,
}

struct ToneMappingUniforms {
  exposureLinear : f32,   // pow(2.0, exposureEV)
  isFp32         : f32,   // 1.0 if rgba32f document, 0.0 otherwise
  operator       : u32,   // 1 = Reinhard, 2 = ACES (future), 0 = clamp only
  _pad           : f32,
}

struct VertexOutput {
  @builtin(position) pos : vec4f,
  @location(0)       uv  : vec2f,
}

@group(0) @binding(0) var blitSampler : sampler;
@group(0) @binding(1) var srcTex      : texture_2d<f32>;
@group(0) @binding(2) var<uniform> u  : BlitRes;
@group(0) @binding(3) var<uniform> tm : ToneMappingUniforms;

@vertex
fn vs_blit(@location(0) position: vec2f, @location(1) uv: vec2f) -> VertexOutput {
  var out: VertexOutput;
  out.pos = vec4f(
    position.x / u.resolution.x * 2.0 - 1.0,
    1.0 - position.y / u.resolution.y * 2.0,
    0.0, 1.0
  );
  out.uv = uv;
  return out;
}

// ── Tone-mapping operators ────────────────────────────────────────────────────
// Add new operators here. Each must map a [0, ∞) linear RGB vec3f to [0, 1].

fn tm_reinhard(c: vec3f) -> vec3f {
  return c / (c + vec3f(1.0));
}

// Placeholder — uncomment and implement when operator == 2u is wired up:
// fn tm_aces_approx(c: vec3f) -> vec3f {
//   let a = 2.51; let b = 0.03; let co = 2.43; let d = 0.59; let e = 0.14;
//   return clamp((c*(a*c+b))/(c*(co*c+d)+e), vec3f(0.0), vec3f(1.0));
// }

@fragment
fn fs_blit(in: VertexOutput) -> @location(0) vec4f {
  let sample = textureSample(srcTex, blitSampler, in.uv);
  if (tm.isFp32 < 0.5) {
    return sample;
  }
  let scaled = sample.rgb * tm.exposureLinear;
  var mapped: vec3f;
  if (tm.operator == 1u) {
    mapped = tm_reinhard(scaled);
  // } else if (tm.operator == 2u) {
  //   mapped = tm_aces_approx(scaled);
  } else {
    // operator == 0u or unknown: clamp only (linear display)
    mapped = clamp(scaled, vec3f(0.0), vec3f(1.0));
  }
  return vec4f(mapped, sample.a);
}
` as const
```

The existing `BLIT_SHADER` and `FBO_BLIT_SHADER` are left untouched. The HDR shader is used only for the on-screen display blit.

**Step 2 — `src/graphics/webgpu/rendering/WebGPURenderer.ts`**

a. At construction (in `create()`), create a second blit pipeline using `HDR_BLIT_SHADER` targeting the swap-chain format (`navigator.gpu.getPreferredCanvasFormat()`). Store it as `private hdrBlitPipeline: GPURenderPipeline`.

b. Create a `private hdrUniformBuffer: GPUBuffer` (16 bytes: `exposureLinear: f32`, `isFp32: f32`, `operator: u32`, `_pad: f32`). Initialize with `[1.0, 0.0, 1, 0]` (EV 0, non-fp32, Reinhard).

c. In the render loop (the method that submits the display blit pass), before recording the blit command:
   - Read `displayStore.exposureEV` and `displayStore.toneMappingOperator`.
   - Compute `exposureLinear = Math.pow(2, displayStore.exposureEV)`.
   - Compute `isFp32 = pixelFormat === 'rgba32f' ? 1.0 : 0.0`.
   - Look up `operatorId = OPERATOR_SHADER_ID[displayStore.toneMappingOperator] ?? 1` (import `OPERATOR_SHADER_ID` from `displayStore.ts`).
   - Build a `Float32Array` for the buffer: `[exposureLinear, isFp32, 0, 0]` with the `u32` at offset 8 written via `DataView.setUint32`. Alternatively, write as four 4-byte values where the third is `operatorId` reinterpreted; use `new DataView(buf).setUint32(8, operatorId, true)` to avoid float reinterpretation.
   - Write the 16-byte buffer to `hdrUniformBuffer` via `device.queue.writeBuffer`.

d. Always use `hdrBlitPipeline` for the display blit (it branches internally on `isFp32`). The standard `BLIT_SHADER` pipeline can be retained for FBO blit (non-display readback paths). Bind `hdrUniformBuffer` at `@group(0) @binding(3)`.

e. The intermediate compositing passes (ping-pong, adjustment, filter) are unaffected; tone-mapping is only in the final display blit.

**Step 3 — `src/core/store/displayStore.ts`**

Create the `DisplayStore` singleton as described in State Changes above.

**Step 4 — `src/core/services/useTabs.ts`**

After the active tab changes (wherever `SWITCH_TAB` is dispatched), call `displayStore.reset()` to clear the EV to 0 for the incoming tab.

### Phase 2 — Tone-Mapping Controls UI

**Step 5 — `src/ux/main/Canvas/ToneMappingControls.tsx` and `ToneMappingControls.module.scss`**

Create the `ToneMappingControls` component as described in New Components above. Style it to sit inline with zoom controls: operator dropdown ~110px wide, EV slider ~120px wide, compact font size. Use the same SCSS variable scale as existing toolbar controls.

**Step 6 — `src/ux/main/Canvas/Canvas.tsx`**

Import and render `<ToneMappingControls pixelFormat={state.pixelFormat} />` in the canvas toolbar area. The component self-manages its visibility.

### Phase 3 — HDR-Aware Color Picker

**Step 7 — `src/ux/widgets/EmbedColorPicker/EmbedColorPicker.tsx`**

Add the following to the existing `EmbedColorPicker`:

**New props:**

```ts
interface EmbedColorPickerProps {
  // ...existing props unchanged...
  isHdrMode?: boolean              // shows Intensity field and float readout when true
  hdrIntensity?: number            // controlled value of the intensity multiplier
  onHdrIntensityChange?: (v: number) => void   // called when user changes intensity
}
```

**New UI elements (rendered only when `isHdrMode === true`):**

1. An **Intensity** numeric `<input>` field (min=`0`, max=`16`, step=`0.01`, default=`1.0`). Positioned below the alpha slider. Validates and clamps input to `[0, 16]` on commit (Tab/Enter). Calls `onHdrIntensityChange`.

2. A **float channel readout** row showing `R: {(r/255 * intensity).toFixed(2)}  G: ...  B: ...  A: {(a/255).toFixed(2)}`. Updated live as the hue/sat picker or intensity field changes. Replaces (or supplements) the 0–255 channel display when `isHdrMode` is true.

3. A small **`HDR`** badge rendered next to the hex swatch when any of the computed float values (R, G, or B after applying intensity) exceeds `1.0`.

**The existing `onChange` callback signature is unchanged.** It continues to emit `{ r, g, b, a }` as integers in `[0, 255]`. The intensity value is propagated separately via `onHdrIntensityChange`, which routes through `AppState.hdrIntensity`.

**Step 8 — Wherever `EmbedColorPicker` is mounted (check `RightPanel` or equivalent)**

Pass `isHdrMode={state.pixelFormat === 'rgba32f'}`, `hdrIntensity={state.hdrIntensity}`, and `onHdrIntensityChange={(v) => dispatch({ type: 'SET_HDR_INTENSITY', payload: v })}`.

**Step 9 — Tool color injection in drawing tools**

All drawing tools that consume `ctx.primaryColor` and write pixel values must apply the intensity multiplier in `rgba32f` mode. The multiplier is read from `AppState.hdrIntensity` which is passed in `ToolContext`. Add `hdrIntensity: number` to `ToolContext` in `src/tools/index.ts` (or wherever `ToolContext` is defined). Tools apply the scale as specified in the Pixel Format Abstraction TD §4:

```ts
// In brush/pencil/fill/cloneStamp/dodge/burn — only when document is rgba32f
const intensity = ctx.pixelFormat === 'rgba32f' ? ctx.hdrIntensity : 1.0
const floatR = (ctx.primaryColor.r / 255) * intensity
const floatG = (ctx.primaryColor.g / 255) * intensity
const floatB = (ctx.primaryColor.b / 255) * intensity
const floatA = ctx.primaryColor.a / 255
```

This applies to the value written into `GpuLayer.data` (Float32Array) via `drawPixel`/`blendPixelOver`.

**Step 10 — Eyedropper HDR indicator**

When the eyedropper samples a pixel in `rgba32f` mode, the composited float values may exceed `1.0`. In the eyedropper handler:
- Clamp `[r, g, b, a]` floats to `[0, 1]` × 255 before setting `primaryColor` in `AppState` (swatch stays 8-bit).
- Set `hdrIntensity` to `1.0` (the picked swatch is already clipped; intensity reset is appropriate).
- The `HDR` badge in `EmbedColorPicker` will fire automatically because after the pick, if the raw sampled value had any channel > 1.0, the stored 8-bit swatch will be at 255 for that channel but the float readout (255/255 × 1.0 = 1.0) will not trigger the badge. The eyedropper therefore passes the raw float values to a separate `displayStore`-style store or the color picker is given a "sampled HDR overflow" flag via a dedicated action. Implement as:

  ```ts
  dispatch({ type: 'SET_EYEDROPPER_HDR_OVERFLOW', payload: sampledChannels.some(c => c > 1.0) })
  ```

  Add `eyedropperHdrOverflow: boolean` to `AppState`. `EmbedColorPicker` receives this as a prop and shows the `HDR` badge unconditionally when true (regardless of intensity). Reset to `false` on any color picker interaction.

### Phase 4 — Status Bar Updates

**Step 11 — `src/ux/main/StatusBar/StatusBar.tsx`**

Replace the hardcoded `"RGB/8"` string with a dynamic label computed from `state.pixelFormat`:

```ts
const formatLabel =
  state.pixelFormat === 'rgba32f'  ? 'RGB/32F' :
  state.pixelFormat === 'indexed8' ? 'Indexed/8' :
  'RGB/8'

const formatClass =
  state.pixelFormat === 'rgba32f' ? styles.formatHdr : undefined
```

Apply `formatClass` to the label span. Add `.formatHdr { color: var(--color-accent-blue, #4a9eff); }` in `StatusBar.module.scss`.

**Pixel info:** The `cursorStore` currently stores `{ x, y }`. The float channel readout requires pixel data. Extend `cursorStore` to also hold an optional `pixelValues: number[] | null` and a `pixelIsFloat: boolean`. `Canvas.tsx` updates these fields from `sampleCanvasPixel` on every `pointermove`. `StatusBar.tsx` renders:

- `rgba8` mode: `R: {r}  G: {g}  B: {b}  A: {a}` (integers 0–255) — unchanged.
- `rgba32f` mode: `R: {r.toFixed(4)}  G: {g.toFixed(4)}  B: {b.toFixed(4)}  A: {a.toFixed(4)}`.

### Phase 5 — EXR File I/O

**Step 12 — `wasm/src/tinyexr.h`**

Add the tinyexr single-header file (pinned to v1.0.9 or latest stable). No modifications to the header; it is included as-is.

**Step 13 — `wasm/src/exr.cpp`**

```cpp
#define TINYEXR_IMPLEMENTATION
#include "tinyexr.h"
#include <emscripten.h>
#include <cstdlib>
#include <cstring>
#include <vector>

// ─── Output struct for loadExr ────────────────────────────────────────────────
//
// Returns pointer to: [width (int32), height (int32), channelCount (int32),
//                      float pixel data (width*height*4 floats)]
// Caller must call freeExrResult(ptr) when done.

struct ExrLoadResult {
  int32_t width;
  int32_t height;
  int32_t channelCount;  // 3 = RGB, 4 = RGBA
  float   pixels[1];     // flexible array — actual allocation is larger
};

extern "C" {

EMSCRIPTEN_KEEPALIVE
ExrLoadResult* loadExr(const uint8_t* data, int dataLen) {
  float*  out  = nullptr;
  int     w = 0, h = 0;
  const char* err = nullptr;
  int ret = LoadEXRFromMemory(&out, &w, &h, data, dataLen, &err);
  if (ret != TINYEXR_SUCCESS) {
    if (err) FreeEXRErrorMessage(err);
    return nullptr;
  }
  // tinyexr returns RGBA interleaved
  size_t pixBytes = (size_t)w * h * 4 * sizeof(float);
  ExrLoadResult* result = (ExrLoadResult*)malloc(sizeof(ExrLoadResult) - sizeof(float) + pixBytes);
  result->width        = w;
  result->height       = h;
  result->channelCount = 4;
  memcpy(result->pixels, out, pixBytes);
  free(out);
  return result;
}

EMSCRIPTEN_KEEPALIVE
void freeExrResult(ExrLoadResult* p) { free(p); }

// ─── saveExr ──────────────────────────────────────────────────────────────────
// Returns a pointer to: [size (int32), bytes[size]] — caller calls freeExrBytes.

EMSCRIPTEN_KEEPALIVE
uint8_t* saveExr(
  const float* pixels, int w, int h,
  int compressionType,  // TINYEXR_COMPRESSIONTYPE_*
  int halfFloat,        // 1 = write as FP16, 0 = FP32
  int* outSize
) {
  EXRHeader header;
  InitEXRHeader(&header);
  EXRImage image;
  InitEXRImage(&image);
  image.num_channels = 4;
  image.width  = w;
  image.height = h;

  // Split RGBA interleaved → separate channel arrays (A, B, G, R — EXR channel order)
  int pixCount = w * h;
  std::vector<float> channelBufs[4];
  for (int c = 0; c < 4; c++) channelBufs[c].resize(pixCount);
  for (int i = 0; i < pixCount; i++) {
    channelBufs[3][i] = pixels[i*4+0];  // R → index 3 (EXR: R)
    channelBufs[2][i] = pixels[i*4+1];  // G
    channelBufs[1][i] = pixels[i*4+2];  // B
    channelBufs[0][i] = pixels[i*4+3];  // A → index 0 (EXR: A, alphabetically first)
  }
  float* images[4] = {
    channelBufs[0].data(), channelBufs[1].data(),
    channelBufs[2].data(), channelBufs[3].data()
  };
  image.images = (unsigned char**)images;

  header.num_channels = 4;
  header.channels = new EXRChannelInfo[4];
  static const char* names[4] = {"A","B","G","R"};
  for (int c = 0; c < 4; c++) {
    strncpy(header.channels[c].name, names[c], 255);
    header.channels[c].pixel_type         = halfFloat ? TINYEXR_PIXELTYPE_HALF : TINYEXR_PIXELTYPE_FLOAT;
  }
  header.pixel_types = new int[4];
  header.requested_pixel_types = new int[4];
  for (int c = 0; c < 4; c++) {
    header.pixel_types[c] = TINYEXR_PIXELTYPE_FLOAT;
    header.requested_pixel_types[c] = halfFloat ? TINYEXR_PIXELTYPE_HALF : TINYEXR_PIXELTYPE_FLOAT;
  }
  header.compression_type = compressionType;

  unsigned char* mem = nullptr;
  size_t memSize = 0;
  const char* err = nullptr;
  int ret = SaveEXRImageToMemory(&image, &header, &mem, &memSize, &err);
  delete[] header.channels;
  delete[] header.pixel_types;
  delete[] header.requested_pixel_types;
  if (ret != TINYEXR_SUCCESS) {
    if (err) FreeEXRErrorMessage(err);
    if (mem) free(mem);
    *outSize = 0;
    return nullptr;
  }
  *outSize = (int)memSize;
  return mem;
}

EMSCRIPTEN_KEEPALIVE
void freeExrBytes(uint8_t* p) { free(p); }

} // extern "C"
```

**Step 14 — `wasm/CMakeLists.txt`**

Add `wasm/src/exr.cpp` to the sources list. Append `_loadExr`, `_freeExrResult`, `_saveExr`, `_freeExrBytes` to `-sEXPORTED_FUNCTIONS`.

**Step 15 — `src/wasm/types.ts`**

Add signatures:

```ts
export interface PixelOpsModule {
  // ...existing...
  _loadExr(dataPtr: number, dataLen: number): number   // returns ExrLoadResult* or 0
  _freeExrResult(ptr: number): void
  _saveExr(
    pixPtr: number, w: number, h: number,
    compression: number, halfFloat: number,
    outSizePtr: number
  ): number   // returns uint8_t* or 0
  _freeExrBytes(ptr: number): void
}
```

**Step 16 — `src/wasm/index.ts` — `decodeExr` and `encodeExr`**

```ts
export interface ExrDecodeResult {
  width: number
  height: number
  data: Float32Array   // RGBA interleaved, width × height × 4
}

export async function decodeExr(bytes: Uint8Array): Promise<ExrDecodeResult> {
  const m = await getPixelOps()
  const dataPtr = m._malloc(bytes.byteLength)
  try {
    m.HEAPU8.set(bytes, dataPtr)
    const resultPtr = m._loadExr(dataPtr, bytes.byteLength)
    if (!resultPtr) throw new Error('EXR decode failed — unsupported format or corrupt file.')
    try {
      // Read header: 3 × int32 = 12 bytes
      const view = new DataView(m.HEAPU8.buffer, resultPtr)
      const w = view.getInt32(0, true)
      const h = view.getInt32(4, true)
      // channelCount at offset 8 (reserved for future use)
      const floatOffset = resultPtr + 12
      const pixelCount  = w * h * 4
      // Re-read HEAPU8 (WASM memory may have grown)
      const pixels = new Float32Array(m.HEAPU8.buffer.slice(floatOffset, floatOffset + pixelCount * 4))
      return { width: w, height: h, data: pixels }
    } finally {
      m._freeExrResult(resultPtr)
    }
  } finally {
    m._free(dataPtr)
  }
}

export interface ExrEncodeOptions {
  compression?: 'none' | 'zip' | 'zips' | 'piz'   // default 'zip'
  halfFloat?: boolean                               // default false (FP32)
}

const EXR_COMPRESSION: Record<string, number> = {
  none: 0, rle: 1, zips: 2, zip: 3, piz: 4,
}

export async function encodeExr(
  pixels: Float32Array,
  width: number,
  height: number,
  options: ExrEncodeOptions = {},
): Promise<Uint8Array> {
  const m = await getPixelOps()
  const compression = EXR_COMPRESSION[options.compression ?? 'zip'] ?? 3
  const halfFloat   = options.halfFloat ? 1 : 0
  const pixPtr = m._malloc(pixels.byteLength)
  const outSizePtr = m._malloc(4)
  try {
    m.HEAPU8.set(new Uint8Array(pixels.buffer), pixPtr)
    const resultPtr = m._saveExr(pixPtr, width, height, compression, halfFloat, outSizePtr)
    if (!resultPtr) throw new Error('EXR encode failed.')
    try {
      const outSize = new DataView(m.HEAPU8.buffer, outSizePtr).getInt32(0, true)
      return m.HEAPU8.slice(resultPtr, resultPtr + outSize)
    } finally {
      m._freeExrBytes(resultPtr)
    }
  } finally {
    m._free(pixPtr)
    m._free(outSizePtr)
  }
}
```

### Phase 6 — Radiance HDR File I/O (Pure TypeScript)

**Step 17 — `src/core/io/hdrCodec.ts` — new file**

Implement pure-TypeScript RGBE encode/decode. No WASM required.

```ts
// ─── RGBE decode ──────────────────────────────────────────────────────────────

export function decodeRgbe(bytes: Uint8Array): { data: Float32Array; width: number; height: number } {
  // Parse ASCII header
  let pos = 0
  let width = 0, height = 0
  // Read lines until blank line (end of header)
  while (pos < bytes.length) {
    let lineEnd = bytes.indexOf(0x0a, pos)
    if (lineEnd < 0) lineEnd = bytes.length
    const line = new TextDecoder().decode(bytes.subarray(pos, lineEnd))
    pos = lineEnd + 1
    if (line === '') break
    const sizeMatch = line.match(/^-Y\s+(\d+)\s+\+X\s+(\d+)/)
    if (sizeMatch) {
      height = parseInt(sizeMatch[1], 10)
      width  = parseInt(sizeMatch[2], 10)
      break
    }
  }
  if (!width || !height) throw new Error('Could not parse Radiance HDR dimensions.')

  const out = new Float32Array(width * height * 4)
  let outIdx = 0

  for (let y = 0; y < height; y++) {
    // New RLE format: scanline starts with [2, 2, highByte, lowByte]
    if (bytes[pos] === 2 && bytes[pos + 1] === 2) {
      const scanW = (bytes[pos + 2] << 8) | bytes[pos + 3]
      pos += 4
      if (scanW !== width) throw new Error('HDR scanline width mismatch.')
      // Four separate RLE channels
      const rgbe = new Uint8Array(width * 4)
      for (let ch = 0; ch < 4; ch++) {
        let x = 0
        while (x < width) {
          const code = bytes[pos++]
          if (code > 128) {
            const run = code - 128
            const val = bytes[pos++]
            for (let i = 0; i < run; i++) rgbe[ch * width + x++] = val
          } else {
            for (let i = 0; i < code; i++) rgbe[ch * width + x++] = bytes[pos++]
          }
        }
      }
      // Interleave and decode
      for (let x = 0; x < width; x++) {
        const R = rgbe[x], G = rgbe[width + x], B = rgbe[2*width + x], E = rgbe[3*width + x]
        decodeRgbePixel(R, G, B, E, out, outIdx)
        outIdx += 4
      }
    } else {
      // Old uncompressed format
      for (let x = 0; x < width; x++) {
        const R = bytes[pos], G = bytes[pos+1], B = bytes[pos+2], E = bytes[pos+3]
        pos += 4
        decodeRgbePixel(R, G, B, E, out, outIdx)
        outIdx += 4
      }
    }
  }
  return { data: out, width, height }
}

function decodeRgbePixel(R: number, G: number, B: number, E: number, out: Float32Array, i: number): void {
  if (E === 0) {
    out[i] = out[i+1] = out[i+2] = 0
  } else {
    const scale = Math.pow(2, E - 128 - 8)
    out[i]   = (R + 0.5) * scale
    out[i+1] = (G + 0.5) * scale
    out[i+2] = (B + 0.5) * scale
  }
  out[i+3] = 1.0
}

// ─── RGBE encode ──────────────────────────────────────────────────────────────

export function encodeRgbe(pixels: Float32Array, width: number, height: number): Uint8Array {
  const header =
    '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n' +
    `-Y ${height} +X ${width}\n`
  const headerBytes = new TextEncoder().encode(header)

  const scanlines = new Uint8Array(width * height * 4 * 2 + 128)  // upper bound
  let outPos = 0

  for (let y = 0; y < height; y++) {
    // Emit new RLE scanline header
    scanlines[outPos++] = 2
    scanlines[outPos++] = 2
    scanlines[outPos++] = (width >> 8) & 0xff
    scanlines[outPos++] = width & 0xff
    // Gather RGBE for this scanline
    const rgbe = new Uint8Array(width * 4)
    for (let x = 0; x < width; x++) {
      const bi  = (y * width + x) * 4
      const r = Math.max(0, pixels[bi]), g = Math.max(0, pixels[bi+1]), b = Math.max(0, pixels[bi+2])
      const maxc = Math.max(r, g, b)
      if (maxc < 1e-32) {
        rgbe[x] = rgbe[width+x] = rgbe[2*width+x] = rgbe[3*width+x] = 0
      } else {
        const exp = Math.ceil(Math.log2(maxc))
        const scale = Math.pow(2, -exp) * 256
        rgbe[x]         = Math.min(255, Math.floor(r * scale))
        rgbe[width + x] = Math.min(255, Math.floor(g * scale))
        rgbe[2*width+x] = Math.min(255, Math.floor(b * scale))
        rgbe[3*width+x] = exp + 128
      }
    }
    // RLE encode each channel
    for (let ch = 0; ch < 4; ch++) {
      const chSlice = rgbe.subarray(ch * width, (ch + 1) * width)
      let x = 0
      while (x < width) {
        let run = 1
        while (run < 127 && x + run < width && chSlice[x + run] === chSlice[x]) run++
        if (run > 2) {
          scanlines[outPos++] = run + 128
          scanlines[outPos++] = chSlice[x]
          x += run
        } else {
          // Find raw run
          let raw = 1
          while (raw < 128 && x + raw < width) {
            const ahead = Math.min(3, width - x - raw)
            let isRun = ahead > 2 && chSlice[x+raw] === chSlice[x+raw+1] && chSlice[x+raw] === chSlice[x+raw+2]
            if (isRun) break
            raw++
          }
          scanlines[outPos++] = raw
          for (let i = 0; i < raw; i++) scanlines[outPos++] = chSlice[x + i]
          x += raw
        }
      }
    }
  }

  const result = new Uint8Array(headerBytes.length + outPos)
  result.set(headerBytes)
  result.set(scanlines.subarray(0, outPos), headerBytes.length)
  return result
}
```

**Step 18 — `src/core/io/exportHdr.ts`**

```ts
import { encodeRgbe } from './hdrCodec'

export function exportHdr(pixels: Float32Array, width: number, height: number): Uint8Array {
  return encodeRgbe(pixels, width, height)
}
```

### Phase 7 — 32-Bit Float TIFF I/O

**Step 19 — Extend `src/core/io/imageLoader.ts` — float TIFF detection**

In the existing TIFF branch (the `data:image/tiff;base64,` case in `loadImagePixels`), after decoding with UTIF, inspect the IFD for `SAMPLEFORMAT = 3` (`t262`) and `BITSPERSAMPLE = 32`. If both conditions are true, extract the raw strip bytes and reinterpret as `Float32Array` (respecting the TIFF byte-order mark `II`/`MM` already parsed by UTIF):

```ts
// After UTIF.decode():
const ifd = ifds[0]
const sampleFormat = (ifd as any).t262?.[0]   // SAMPLEFORMAT tag
const bitsPerSample = (ifd as any).t258?.[0]  // BITSPERSAMPLE tag
if (sampleFormat === 3 && bitsPerSample === 32) {
  // Float32 TIFF — return raw floats; caller handles rgba32f document creation
  return { data: extractTiffFloat32(bytes, ifd), width: ifd.width, height: ifd.height, isHdr: true }
}
```

`extractTiffFloat32` is a private helper in `imageLoader.ts` that reads the strip data from the raw TIFF bytes using UTIF's strip offset/length tags, concatenates strip bytes in order, and wraps in `Float32Array`. If the TIFF is big-endian (`MM` byte order), byteswap each 4-byte float. Returns a `Float32Array` of length `width × height × 4` with alpha defaulting to `1.0` if only 3 channels.

The `loadImagePixels` return type is widened to:

```ts
Promise<{ data: Uint8Array | Float32Array; width: number; height: number; isHdr?: boolean }>
```

All existing callers that destructure `data` as `Uint8Array` must be updated to narrow the type where appropriate (only the HDR-aware code path in `useFileOps` uses `Float32Array`).

**Step 20 — `src/core/io/exportTiff32.ts`**

Write a minimal uncompressed 32-bit float TIFF without any external library:

```ts
export function exportTiff32(pixels: Float32Array, width: number, height: number): Uint8Array {
  // IFD fields required: ImageWidth, ImageLength, BitsPerSample, Compression,
  //   PhotometricInterpretation, StripOffsets, SamplesPerPixel, RowsPerStrip,
  //   StripByteCounts, XResolution, YResolution, ResolutionUnit, SampleFormat
  // Write as little-endian (II) uncompressed.
  const HEADER_SIZE  = 8
  const IFD_ENTRY    = 12
  const NUM_FIELDS   = 13
  const IFD_SIZE     = 2 + NUM_FIELDS * IFD_ENTRY + 4   // count + entries + nextIFD
  const RATIONAL_BUF = 16   // 2 rational values (XRes, YRes) × 8 bytes each
  const pixelBytes   = pixels.byteLength
  const totalSize    = HEADER_SIZE + IFD_SIZE + RATIONAL_BUF + pixelBytes
  const buf = new ArrayBuffer(totalSize)
  const view = new DataView(buf)

  // TIFF header: 'II' + magic 42 + IFD offset
  view.setUint16(0, 0x4949, true)   // 'II' little-endian
  view.setUint16(2, 42, true)
  view.setUint32(4, HEADER_SIZE, true)  // IFD starts right after header

  const ifdBase = HEADER_SIZE
  let off = ifdBase
  view.setUint16(off, NUM_FIELDS, true); off += 2

  const rationalBase = ifdBase + IFD_SIZE
  const pixelBase    = rationalBase + RATIONAL_BUF

  function writeEntry(tag: number, type: number, count: number, valueOrOffset: number): void {
    view.setUint16(off, tag, true);          off += 2
    view.setUint16(off, type, true);         off += 2
    view.setUint32(off, count, true);        off += 4
    view.setUint32(off, valueOrOffset, true); off += 4
  }

  writeEntry(256, 4, 1, width)                     // ImageWidth (LONG)
  writeEntry(257, 4, 1, height)                    // ImageLength
  writeEntry(258, 3, 1, 32)                        // BitsPerSample = 32 (SHORT)
  writeEntry(259, 3, 1, 1)                         // Compression = 1 (none)
  writeEntry(262, 3, 1, 2)                         // PhotometricInterpretation = RGB
  writeEntry(278, 4, 1, height)                    // RowsPerStrip = all rows
  writeEntry(277, 3, 1, 4)                         // SamplesPerPixel = 4
  writeEntry(273, 4, 1, pixelBase)                 // StripOffsets
  writeEntry(279, 4, 1, pixelBytes)                // StripByteCounts
  writeEntry(282, 5, 1, rationalBase)              // XResolution (RATIONAL)
  writeEntry(283, 5, 1, rationalBase + 8)          // YResolution
  writeEntry(296, 3, 1, 2)                         // ResolutionUnit = inch
  writeEntry(339, 3, 1, 3)                         // SampleFormat = 3 (IEEE float)
  view.setUint32(off, 0, true)                     // next IFD = 0 (none)

  // Rational values: 72/1 for both X and Y resolution
  view.setUint32(rationalBase,      72, true)
  view.setUint32(rationalBase + 4,  1,  true)
  view.setUint32(rationalBase + 8,  72, true)
  view.setUint32(rationalBase + 12, 1,  true)

  // Pixel data — copy float bytes directly (already little-endian on all WebGPU platforms)
  new Uint8Array(buf).set(new Uint8Array(pixels.buffer), pixelBase)

  return new Uint8Array(buf)
}
```

### Phase 8 — imageLoader and Import Path

**Step 21 — `src/core/io/imageLoader.ts`**

a. Add `.exr` and `.hdr` to `IMAGE_EXTENSIONS` and `EXT_TO_MIME`:

```ts
IMAGE_EXTENSIONS.add('.exr')
IMAGE_EXTENSIONS.add('.hdr')
EXT_TO_MIME['.exr'] = 'image/x-exr'
EXT_TO_MIME['.hdr'] = 'image/vnd.radiance'
```

b. In `loadImagePixels`, add two new branches before the `<img>` fallback. EXR uses the WASM decoder; HDR uses the pure-TS decoder from `hdrCodec.ts`:

```ts
if (dataUrl.startsWith('data:image/x-exr;base64,')) {
  const bytes = base64ToBytes(dataUrl.slice('data:image/x-exr;base64,'.length))
  const result = await decodeExr(bytes)
  return { data: result.data, width: result.width, height: result.height, isHdr: true }
}

if (dataUrl.startsWith('data:image/vnd.radiance;base64,')) {
  const bytes = base64ToBytes(dataUrl.slice('data:image/vnd.radiance;base64,'.length))
  const result = decodeRgbe(bytes)
  return { data: result.data, width: result.width, height: result.height, isHdr: true }
}
```

`base64ToBytes` is a private helper (or inline decode) already effectively present in the TGA/TIFF branches — extract it as a shared function.

**Step 22 — `src/core/services/useFileOps.ts`**

In the file-open path, after calling `loadImagePixels`, check `isHdr`:

```ts
const loaded = await loadImagePixels(dataUrl)
if (loaded.isHdr) {
  // Create tab with pixelFormat: 'rgba32f' and Float32Array layer data
  // ...create tab, set pixelFormat in dispatch payload...
  showToast('HDR file opened in RGB/32F mode.')
} else {
  // existing rgba8 path unchanged
}
```

The tab creation for HDR files passes `pixelFormat: 'rgba32f'` in the `OPEN_FILE` dispatch payload (as defined by the Pixel Format Abstraction TD's canvas-resetting action updates).

### Phase 9 — Export Path

**Step 23 — `src/ux/modals/ExportDialog/ExportDialog.tsx`**

Add three new format options, gated to `rgba32f` documents. A new `isHdrDocument` prop controls visibility:

```ts
// New format values
type ExportFormat = 'png' | 'jpeg' | 'webp' | 'tga' | 'tiff' | 'exr' | 'hdr' | 'tiff32'
```

When `isHdrDocument` is true, show EXR, HDR, and TIFF32 options. The EXR option shows a sub-selector for compression type (`None`, `ZIP`, `ZIPS`, `PIZ`) and a "Save as half-float (FP16)" checkbox.

The `ExportSettings` type gains:

```ts
interface ExportSettings {
  // ...existing...
  format: ExportFormat
  exrCompression?: 'none' | 'zip' | 'zips' | 'piz'
  exrHalfFloat?: boolean
}
```

**Step 24 — `src/core/services/useExportOps.ts`**

Add HDR format branches and the LDR-warning dialog:

```ts
const handleExportConfirm = useCallback(async (settings: ExportSettings): Promise<void> => {
  const isHdrDoc = stateRef.current.pixelFormat === 'rgba32f'
  const isLdrFormat = ['png','jpeg','webp','tga','tiff'].includes(settings.format)

  if (isHdrDoc && isLdrFormat) {
    // Show warning dialog — actual export is deferred until confirmation
    setLdrWarningSettings(settings)
    return
  }

  await doExport(settings)
}, ...)

const doExport = useCallback(async (settings: ExportSettings): Promise<void> => {
  const handle = canvasHandleRef.current
  if (!handle) throw new Error('Canvas not ready.')
  const flat = await handle.rasterizeLayers(stateRef.current.layers, 'export')

  if (settings.format === 'exr') {
    const bytes = await encodeExr(flat.data as Float32Array, flat.width, flat.height, {
      compression: settings.exrCompression,
      halfFloat: settings.exrHalfFloat,
    })
    await window.api.exportImage(settings.filePath, Buffer.from(bytes).toString('base64'))
    return
  }

  if (settings.format === 'hdr') {
    const bytes = exportHdr(flat.data as Float32Array, flat.width, flat.height)
    await window.api.exportImage(settings.filePath, Buffer.from(bytes).toString('base64'))
    return
  }

  if (settings.format === 'tiff32') {
    const bytes = exportTiff32(flat.data as Float32Array, flat.width, flat.height)
    await window.api.exportImage(settings.filePath, Buffer.from(bytes).toString('base64'))
    return
  }

  // LDR formats: apply tone-mapping using the active operator before encoding
  const ldrPixels = isHdrDoc
    ? toneMapToUint8(flat.data as Float32Array, displayStore.toneMappingOperator)
    : flat.data as Uint8Array

  // ...existing format branches (png, jpeg, etc.) using ldrPixels...
}, ...)
```

`toneMapToUint8` is a pure-TS helper in `useExportOps.ts` (or `src/utils/pixelFormatConvert.ts`). It dispatches to the same operator that is active in `displayStore`, so the exported preview matches what the user saw on screen. The EV from `displayStore.exposureEV` is also applied:

```ts
import type { ToneMappingOperator } from '@/types'

function toneMapToUint8(f32: Float32Array, operator: ToneMappingOperator, exposureEV = 0): Uint8Array {
  const out = new Uint8Array(f32.length)
  const exposureLinear = Math.pow(2, exposureEV)
  for (let i = 0; i < f32.length; i += 4) {
    const r = f32[i]   * exposureLinear
    const g = f32[i+1] * exposureLinear
    const b = f32[i+2] * exposureLinear
    let mr: number, mg: number, mb: number
    if (operator === 'reinhard') {
      mr = r / (r + 1); mg = g / (g + 1); mb = b / (b + 1)
    // } else if (operator === 'aces') {
    //   [mr, mg, mb] = acesApprox(r, g, b)
    } else {
      mr = Math.min(1, r); mg = Math.min(1, g); mb = Math.min(1, b)
    }
    out[i]   = Math.round(mr * 255)
    out[i+1] = Math.round(mg * 255)
    out[i+2] = Math.round(mb * 255)
    out[i+3] = Math.round(Math.min(1, f32[i+3]) * 255)  // alpha: clamp only
  }
  return out
}
```

At the call site, pass `displayStore.toneMappingOperator` and `displayStore.exposureEV` so the LDR export precisely mirrors the display preview.

**Step 25 — `src/ux/modals/HdrLdrExportWarningDialog/HdrLdrExportWarningDialog.tsx`**

Create the warning modal as described in New Components. Wire it into `useExportOps` via a `pendingLdrExport` state in `App.tsx` (same pattern as other dialogs).

### Phase 10 — Barrel Exports

**Step 26 — `src/ux/index.ts`**

Add exports for `ToneMappingControls` and `HdrLdrExportWarningDialog`.

---

## Architectural Constraints

- **`App.tsx` stays thin.** The EV slider lives inside `Canvas.tsx` (it is a canvas-view-level control, not an application-level control). The HDR-to-LDR export warning dialog state may be a local `useState` in `useExportOps` (via a returned setter) that `App.tsx` renders conditionally — same pattern as `ConvertColorModeDialog`.

- **Module-level singleton for EV, not React state.** `displayStore.exposureEV` is read each frame in the GPU render loop without going through React. Storing it in `AppState` would cause unnecessary re-renders on every slider drag tick. This follows the same pattern as `brushOptions`, `cursorStore`, and `cropStore`.

- **Tone-mapping only in the display blit; operator-dispatched in one shader.** The `HDR_BLIT_SHADER` contains all operator implementations as WGSL functions; the active one is selected by a `u32` uniform. Adding a new operator requires: (1) a new `ToneMappingOperator` literal in `src/types/index.ts`, (2) a new entry in `OPERATOR_SHADER_ID` in `displayStore.ts`, (3) a new WGSL function + `else if` branch in `HDR_BLIT_SHADER`, (4) a new label entry in `ToneMappingControls`, and (5) a new branch in `toneMapToUint8`. No structural changes to the pipeline, renderer, or state management are required. All compositing passes (ping-pong textures, adjustment encoder, filter compute) operate in full float range. The rasterization pipeline (`rasterizeDocument`) never applies tone-mapping regardless of `reason`.

- **`toneMappingOperator` is a global display preference, not per-tab or persisted in the document.** It lives in `displayStore` alongside `exposureEV`. Unlike `exposureEV`, it is not reset on tab switch — users typically want consistent display transform across all tabs. If per-document operator persistence is ever needed, the operator string should move to `TabRecord` and be written/read alongside `pixelFormat` in `useTabs`.

- **EXR multi-layer import.** Multi-layer EXR is deferred to a later iteration. V1 imports only the first RGBA layer group. The spec explicitly scopes this: "each EXR layer/channel group is imported as a separate Verve layer where possible" — the WASM `loadExr` wrapper returns only the merged RGBA result for V1; the channel-group splitting logic is left as a future extension point inside `decodeExr`.

- **No WASM for RGBE.** The Radiance HDR codec is pure TypeScript. RGBE is simple arithmetic with no inner loop that benefits from WASM vectorisation at these image sizes. This avoids adding another WASM compilation dependency.

- **TIFF float write without WASM.** The baseline uncompressed 32-bit float TIFF writer is pure TypeScript. LZW/Deflate compression for TIFF32 is explicitly out of scope for V1 per the spec; if needed it can be added via a WASM libtiff wrapper later.

- **`RENDER_ATTACHMENT` usage on `rgba32float` textures.** Already required and handled by the Pixel Format Abstraction foundation. The `HDR_BLIT_SHADER` pipeline reads from the composited `rgba32float` texture as a `texture_2d<f32>` sampler binding, not a render attachment — no additional usage flags needed for the blit source.

- **IPC export path for binary HDR files.** Current `window.api.exportImage` receives a base64 string and the main process decodes it. EXR, HDR, and TIFF32 output are `Uint8Array`; these are base64-encoded in the renderer before the IPC call — matching the existing pattern used by PNG and TIFF.

---

## Open Questions

1. **tinyexr build size.** tinyexr with miniz (ZIP compression) adds approximately 300–500 KB to the WASM binary. If build size is a concern, the PIZ compression codec can be excluded by `#define TINYEXR_USE_PIZ 0` before inclusion. Confirm acceptable binary size budget before finalising the build flags.

2. **Multi-layer EXR.** The spec describes per-layer-group import. The V1 WASM wrapper collapses everything to a single merged RGBA layer. A future pass needs a `loadExrLayers` WASM function that returns multiple named float buffers. This should be noted as a tracked follow-on, not silently omitted.

3. **EV persistence across tab switches.** The spec says EV is per-session, per-tab, and resets to 0 on tab switch. `displayStore` is a single global singleton, so tab-switching does reset it (to 0) as desired. If the requirement changes to per-tab EV persistence (e.g. remembered until the tab is closed), the EV would need to move into `TabRecord`. Flag this before implementation.

4. **Half-float EXR export and precision warning.** When the user enables "Save as half-float (FP16)", values outside the half-float range (approximately ±65504) will be clamped or become Inf. The export dialog should note this. Confirm whether a dedicated warning is required or whether the checkbox label is sufficient.

5. **`window.api.exportImage` signature for binary.** Verify that the main-process IPC handler for `exportImage` accepts arbitrary base64 (not just image MIME types). EXR and HDR files have non-standard MIME types. If the main process validates MIME type, it must be updated to accept `image/x-exr` and `image/vnd.radiance`, or the API must be widened to a generic binary-write call.

6. **Future tone-mapping operators — ACEScg, Filmic, AgX.** The WGSL dispatch table and `ToneMappingOperator` union are the only files that must change when adding a new operator. Before adding ACEScg in particular, clarify whether scene-linear ACEScg (requiring an input transform from sRGB/Rec.709) or the ACES sRGB approximate (no input transform) is intended. The approximate formula is already stubbed in the shader. Full ACEScg would require an additional IDT (Input Device Transform) matrix multiplication upstream of the tonemap function.
