# Technical Design: Curves

## Overview

The Curves adjustment is a non-destructive child layer that remaps the tonal response of a parent pixel layer through one master RGB curve plus three per-channel curves. The effect must remain fully editable, apply only to the parent layer subtree, support baked selection scoping, and render live during point drag without mutating the parent pixels. When the user triggers **Image -> Curves...**, a `CurvesAdjustmentLayer` record is inserted into `state.layers` immediately after the active pixel layer, `openAdjustmentLayerId` is set to the new layer's ID, and `AdjustmentPanel` opens showing `CurvesPanel`. Curve edits dispatch `UPDATE_ADJUSTMENT_LAYER` updates; on every update the canvas re-renders through the WebGL compositing pipeline using precomputed 256-entry LUT textures rather than evaluating the spline per fragment. One undo entry is recorded when the panel closes.

Curves is the first adjustment that makes three existing gaps impossible to ignore: parent-scoped adjustment rendering, persistence of baked adjustment masks, and efficient readback of the pre-adjustment input for histogram display. This design addresses those generically so Curves lands on correct infrastructure instead of repeating the current full-screen adjustment shortcut.

This design builds on `adjustment-menu.md` and the existing adjustment documents, but intentionally replaces the current "apply adjustment to the accumulated composite" render model with a parent-scoped adjustment-group model. That change is necessary for spec correctness and should be adopted for all adjustment children, not just Curves.

---

## Affected Areas

| File | Change |
|---|---|
| `src/types/index.ts` | Add `'curves'` to `AdjustmentType`; add `CurvesChannel`, `CurvesControlPoint`, `CurvesAdjustmentParams`, and `CurvesAdjustmentLayer`; extend `AdjustmentParamsMap` and `AdjustmentLayerState` |
| `src/adjustments/registry.ts` | Add `'curves'` entry to `ADJUSTMENT_REGISTRY` with linear default params |
| `src/components/panels/AdjustmentPanel/AdjustmentPanel.tsx` | Add Curves title/icon wiring and `case 'curves'` |
| `src/components/panels/CurvesPanel/CurvesPanel.tsx` | **New file.** Panel component that owns Curves UI state reads/writes, copy/paste, preview toggle, and preset actions |
| `src/components/panels/CurvesPanel/CurvesPanel.module.scss` | **New file.** Scoped panel styles |
| `src/components/widgets/CurvesGraph/CurvesGraph.tsx` | **New file.** Props-only interactive graph widget with histogram overlay, points, keyboard nudge, and clipping indicators |
| `src/components/widgets/CurvesGraph/CurvesGraph.module.scss` | **New file.** Scoped graph styles |
| `src/components/index.ts` | Export `CurvesGraph` only if other panels will reuse it; otherwise no new barrel export is needed because `CurvesPanel` is consumed by `AdjustmentPanel` only |
| `src/hooks/useCurvesHistogram.ts` | **New file.** Owns histogram request scheduling, caching, and stale-result dropping |
| `src/hooks/useCurvesPresets.ts` | **New file.** Loads/saves custom preset library via typed preload IPC |
| `src/store/adjustmentPreviewStore.ts` | **New file.** Ephemeral preview-bypass store keyed by adjustment layer ID |
| `src/store/adjustmentClipboardStore.ts` | **New file.** Module-level in-app clipboard for versioned adjustment-settings payloads |
| `src/components/window/Canvas/canvasPlan.ts` | Replace per-adjustment flat plan building with parent-scoped adjustment-group entries; add Curves entry builder |
| `src/components/window/Canvas/Canvas.tsx` | Build grouped render plans; subscribe to preview-bypass store; restore adjustment masks during tab/file init |
| `src/components/window/Canvas/canvasHandle.ts` | Add methods for exporting/restoring adjustment masks and reading the input pixels for a target adjustment layer |
| `src/webgl/shaders.ts` | Add `CURVES_FRAG`; optionally add a small helper for LUT sampling; keep `BC_VERT` as the shared full-screen vertex stage |
| `src/webgl/WebGLRenderer.ts` | Add grouped adjustment render path, `curvesProgram`, LUT texture management helpers, `applyCurvesPass`, and `readAdjustmentInputPlan` |
| `src/hooks/useHistory.ts` | Capture and restore baked adjustment masks alongside layer pixels so undo/redo preserves selection-scoped Curves layers |
| `src/store/historyStore.ts` | Extend `HistoryEntry` with `adjustmentMasks` |
| `src/hooks/useTabs.ts` | Serialize/restore adjustment-mask PNG data for inactive tabs |
| `src/hooks/useFileOps.ts` | Persist Curves layer params via `state.layers` and persist baked adjustment masks via an optional `adjustmentMaskPng` field in `.verve` layer payloads |
| `electron/main/ipc.ts` | Add typed IPC for loading/saving custom Curves presets under app user data |
| `electron/preload/index.ts` | Expose Curves preset IPC methods to the renderer |
| `electron/preload/index.d.ts` | Add Curves preset IPC typings |
| `src/wasm/types.ts` | Add histogram result signature |
| `src/wasm/index.ts` | Add high-level `computeHistogramRGBA` wrapper |
| `wasm/src/curves_histogram.h` | **New file.** Histogram kernel declaration |
| `wasm/src/curves_histogram.cpp` | **New file.** Four-channel histogram implementation |
| `wasm/src/pixelops.cpp` | Export histogram entry point |
| `wasm/CMakeLists.txt` | Export the histogram symbol |

---

## State Changes

### New entries in `src/types/index.ts`

#### Extend `AdjustmentType`

```ts
export type AdjustmentType =
  | 'brightness-contrast'
  | 'hue-saturation'
  | 'color-vibrance'
  | 'color-balance'
  | 'black-and-white'
  | 'color-temperature'
  | 'color-invert'
  | 'selective-color'
  | 'curves'
```

#### New Curves-specific types

```ts
export type CurvesChannel = 'rgb' | 'red' | 'green' | 'blue'

export interface CurvesControlPoint {
  id: string
  x: number   // 0..255, strictly increasing per channel
  y: number   // 0..255
}

export interface CurvesChannelCurve {
  points: CurvesControlPoint[]
}

export interface CurvesVisualAids {
  gridDensity: '4x4' | '8x8'
  showClippingIndicators: boolean
  showReadout: boolean
}

export interface CurvesPresetRef {
  source: 'builtin' | 'custom'
  id: string
  name: string
  dirty: boolean
}
```

#### Extend `AdjustmentParamsMap`

Curves stores both effect-defining state and the persisted panel preferences the spec requires to survive close/reopen. The temporary Preview toggle is intentionally excluded because it is panel-session-only and should not be serialized.

```ts
export interface AdjustmentParamsMap {
  // ...existing entries...
  'curves': {
    version: 1
    channels: Record<CurvesChannel, CurvesChannelCurve>
    ui: {
      selectedChannel: CurvesChannel
      visualAids: CurvesVisualAids
      presetRef: CurvesPresetRef | null
    }
  }
}
```

The default linear Curves params are:

```ts
{
  version: 1,
  channels: {
    rgb:   { points: [{ id: 'rgb-0',   x: 0,   y: 0   }, { id: 'rgb-255',   x: 255, y: 255 }] },
    red:   { points: [{ id: 'red-0',   x: 0,   y: 0   }, { id: 'red-255',   x: 255, y: 255 }] },
    green: { points: [{ id: 'green-0', x: 0,   y: 0   }, { id: 'green-255', x: 255, y: 255 }] },
    blue:  { points: [{ id: 'blue-0',  x: 0,   y: 0   }, { id: 'blue-255',  x: 255, y: 255 }] },
  },
  ui: {
    selectedChannel: 'rgb',
    visualAids: { gridDensity: '4x4', showClippingIndicators: true, showReadout: true },
    presetRef: null,
  },
}
```

#### New layer interface

```ts
export interface CurvesAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'curves'
  params: AdjustmentParamsMap['curves']
  /** True when a selection was active at creation time; baked mask pixels live outside React state. */
  hasMask: boolean
}
```

#### Extend `AdjustmentLayerState`

```ts
export type AdjustmentLayerState =
  | BrightnessContrastAdjustmentLayer
  | HueSaturationAdjustmentLayer
  | ColorVibranceAdjustmentLayer
  | ColorBalanceAdjustmentLayer
  | BlackAndWhiteAdjustmentLayer
  | ColorTemperatureAdjustmentLayer
  | ColorInvertAdjustmentLayer
  | SelectiveColorAdjustmentLayer
  | CurvesAdjustmentLayer
```

---

## Persistent vs Ephemeral State

### Persistent document state

The following Curves state lives in `state.layers` and is therefore automatically present in `TabSnapshot`, `historyStore` layer snapshots, and `.verve` documents once the relevant serializers are updated:

- Channel control points for RGB, Red, Green, and Blue
- Persisted panel preferences: selected channel and visual-aid toggles
- Preset link metadata (`presetRef`) so reopening the panel can show whether the layer still matches a known preset
- `hasMask`

### Persistent non-React mask state

The baked adjustment selection mask remains in `Canvas.adjustmentMaskMap`, not in `AppState`, because it is full-canvas pixel data and would be too expensive to copy through the reducer. Curves must extend the existing persistence path so this mask survives:

- tab switches
- undo/redo
- `.verve` save/load

This design does **not** move adjustment masks into React state. Instead it adds explicit capture/restore APIs in `canvasHandle.ts` and serializes the mask as optional binary/PNG data keyed by adjustment layer ID.

### Ephemeral panel state

The following state is intentionally not serialized and not included in `UPDATE_ADJUSTMENT_LAYER` payloads:

- Preview toggle on/off state
- Currently selected point ID
- Hovered tone position
- Axis-lock drag direction
- Inline validation/error banner visibility
- Pending preset rename text field values

These live in `CurvesPanel` local state/refs because they are UI-session state, not document state.

---

## Serialization and Persistence

### `.verve` documents

`useFileOps.ts` already persists `state.layers` as JSON layer records plus optional `pngData` / `layerGeo`. Curves layer params will therefore persist automatically once the type is added. The missing piece is the baked selection mask.

For any adjustment layer with `hasMask = true`, `handleSave()` must include:

```ts
layers: state.layers.map(layer => ({
  ...layer,
  pngData: layerPngs[layer.id] ?? null,
  layerGeo: layerGeos[layer.id] ?? null,
  adjustmentMaskPng: adjustmentMaskPngs[layer.id] ?? null,
}))
```

Notes:

- `adjustmentMaskPng` is optional and only present for adjustment layers with baked masks.
- The mask is always full-canvas, so no extra geometry field is needed.
- Document `version` can stay at `1` because the field is additive and optional; old documents simply omit it.

On open, `useFileOps.ts` reconstructs the `CurvesAdjustmentLayer` into `snapshot.layers` and also populates `pendingLayerData` with `${layerId}:adjustment-mask` synthetic keys, mirroring the existing `${layerId}:geo` pattern.

### Inactive tab snapshots

`useTabs.serializeActiveTabPixels()` must add optional entries of the form `${layerId}:adjustment-mask` for each adjustment mask currently in `adjustmentMaskMap`. `Canvas` init code then checks for those keys and recreates the corresponding WebGL mask layers before the first render.

### Undo/redo

`HistoryEntry` in `src/store/historyStore.ts` must be extended:

```ts
export interface HistoryEntry {
  // ...existing fields...
  adjustmentMasks: Map<string, Uint8Array>
}
```

`useHistory.captureHistory()` captures mask pixels via a new canvas-handle method, and `onPreview` / `onJumpTo` restore them before re-rendering. Without this, undoing a masked Curves layer would restore the layer state but silently lose the selection scope.

---

## Presets and Clipboard Architecture

### Built-in presets

Built-in Curves presets live in a new pure-data module:

```ts
src/adjustments/curvesPresets.ts
```

Each entry contains only effect data, not panel-session state:

```ts
interface BuiltinCurvesPreset {
  id: 'linear' | 'medium-contrast' | 'strong-contrast' | 'invert'
  label: string
  channels: Record<CurvesChannel, CurvesChannelCurve>
}
```

Required built-ins from the spec:

- Linear
- Medium Contrast S-curve
- Strong Contrast S-curve
- Inverted curve

Applying a preset copies its `channels` into the layer params and sets:

```ts
ui.presetRef = { source: 'builtin', id, name: label, dirty: false }
```

If the user subsequently edits any point, `dirty` becomes `true`. The panel displays the linked preset name until the settings diverge; once diverged, the dropdown shows the preset name plus an unsaved/custom state instead of pretending the layer still exactly matches the preset.

### Custom presets

Custom presets are application-level user data, not document data. They should not be stored in `AppContext` or duplicated inside every `.verve` file.

Add typed preload IPC:

- `window.api.loadCurvesPresets(): Promise<CurvesCustomPreset[]>`
- `window.api.saveCurvesPresets(presets: CurvesCustomPreset[]): Promise<void>`

Main-process persistence writes a JSON file under Electron user data, for example:

```ts
<userData>/curves-presets.json
```

Preset file schema:

```ts
interface CurvesCustomPreset {
  id: string
  name: string
  version: 1
  channels: Record<CurvesChannel, CurvesChannelCurve>
  createdAt: number
  updatedAt: number
}
```

Only curve shapes are stored. Selected channel, visual aids, preview state, and current point selection are not part of presets.

### Copy/Paste settings

Curves copy/paste should not reuse the existing pixel clipboard store because that store is semantically for raster data and already has a different shape.

Add a dedicated singleton:

```ts
src/store/adjustmentClipboardStore.ts
```

```ts
type AdjustmentClipboardData =
  | {
      kind: 'curves-settings'
      version: 1
      payload: AdjustmentParamsMap['curves']
    }
  | null
```

Copy stores the full persisted Curves settings payload, including `ui.selectedChannel`, `visualAids`, and `presetRef`, but excluding Preview and current point selection because they are not part of persisted layer state.

Paste validation must check:

- `kind === 'curves-settings'`
- `version === 1`
- all four channels exist
- endpoints `(0,0)` and `(255,255)` are present and fixed
- points are strictly increasing in `x`
- all coordinates are finite integers in `[0,255]`

Invalid payloads do not dispatch any reducer action. `CurvesPanel` shows a non-blocking inline error banner for a short duration; no global toast system is required.

---

## Curve Model and LUT Generation

### Control-point rules

Each channel always contains at least two fixed endpoints:

$$
(0,0) \quad \text{and} \quad (255,255)
$$

Non-endpoint points may be added, moved, or deleted. The UI enforces:

- endpoints cannot be removed
- `x` cannot cross adjacent points
- `x` and `y` are clamped to `[0,255]`
- `Shift`-drag locks to the dominant axis
- arrow keys nudge by `1`
- `Shift + Arrow` nudges by `10`

### Interpolation

Curves should use **monotone cubic Hermite interpolation** with Fritsch-Carlson tangents. This gives a smooth response while guaranteeing no overshoot in `y` between neighboring points whose `x` values are monotonic.

Why this choice:

- linear interpolation is too coarse and visibly segmented
- Catmull-Rom / generic cubic splines can overshoot and violate intuitive tone mapping
- Fritsch-Carlson produces a smooth graph and stable point editing behavior

For each channel, the curve is resampled into a 256-entry LUT whenever the point set changes.

### LUT generation

For each input code value $i \in [0,255]$, evaluate the interpolated curve and clamp to `[0,255]`:

$$
L_c[i] = \operatorname{clamp}(\operatorname{round}(f_c(i)), 0, 255)
$$

where $c \in \{rgb, red, green, blue\}$.

The evaluation runs on the CPU in TypeScript because:

- the work is tiny: four channels times 256 samples
- it avoids per-fragment spline evaluation in GLSL
- it makes clipping detection trivial (`L_c[i] === 0 || L_c[i] === 255`)
- it keeps the shader fast and deterministic

Generated LUTs are uploaded as four `256 x 1` textures. `RGBA8` textures are acceptable for implementation simplicity; the shader samples the `.r` channel only.

---

## Pixel Math and GPU Pass

**No full-image Curves evaluation should run in WASM.** The final adjustment remains a GPU pass; only histogram generation uses WASM.

### Channel application order

The spec requires master RGB first, then per-channel curves:

$$
R_1 = L_{rgb}[R_{in}] \qquad G_1 = L_{rgb}[G_{in}] \qquad B_1 = L_{rgb}[B_{in}]
$$

$$
R_{out} = L_{red}[R_1] \qquad G_{out} = L_{green}[G_1] \qquad B_{out} = L_{blue}[B_1]
$$

Alpha is preserved unchanged. Fully transparent pixels are returned early.

### New GLSL — `CURVES_FRAG` in `src/webgl/shaders.ts`

The vertex stage reuses `BC_VERT`. Add a new fragment shader constant:

```ts
export const CURVES_FRAG = /* glsl */ `#version 300 es
  precision mediump float;

  uniform sampler2D u_src;
  uniform sampler2D u_rgbLut;
  uniform sampler2D u_redLut;
  uniform sampler2D u_greenLut;
  uniform sampler2D u_blueLut;
  uniform sampler2D u_selMask;
  uniform bool u_hasSelMask;

  in vec2 v_texCoord;
  out vec4 fragColor;

  float sampleLut(sampler2D lut, float channelValue) {
    float u = clamp(channelValue, 0.0, 1.0);
    return texture(lut, vec2(u, 0.5)).r;
  }

  void main() {
    vec4 src = texture(u_src, v_texCoord);
    if (src.a < 0.0001) { fragColor = src; return; }

    vec3 rgb1 = vec3(
      sampleLut(u_rgbLut, src.r),
      sampleLut(u_rgbLut, src.g),
      sampleLut(u_rgbLut, src.b)
    );

    vec3 adjusted = vec3(
      sampleLut(u_redLut,   rgb1.r),
      sampleLut(u_greenLut, rgb1.g),
      sampleLut(u_blueLut,  rgb1.b)
    );

    vec4 result = vec4(adjusted, src.a);
    float mask = u_hasSelMask ? texture(u_selMask, v_texCoord).r : 1.0;
    fragColor = mix(src, result, mask);
  }
` as const
```

### Boundary checks

| Condition | Expected result |
|---|---|
| All four LUTs are identity | Output is visually identical to input |
| RGB LUT inverts and per-channel LUTs are identity | Composite inversion across all channels |
| Red LUT differs, Green/Blue identity | Only red response changes after the master RGB remap |
| Alpha = 0 | Pixel unchanged |
| Selection mask value = 0 | Pixel unchanged |
| Selection mask value = 1 | Full Curves result |

---

## Renderer and Compositing Integration

### Why the current flat adjustment plan is insufficient

The current adjustment render path applies an adjustment pass to the accumulated composite texture. That cannot satisfy the Curves spec because it affects lower layers beneath the parent and makes the histogram source ambiguous.

Curves therefore requires a **parent-scoped adjustment group** render model.

### New render-plan shape

Replace flat per-adjustment entries with grouped entries built in `canvasPlan.ts`:

```ts
type ScopedAdjustmentRenderOp =
  | { kind: 'brightness-contrast'; layerId: string; ... }
  | { kind: 'hue-saturation'; layerId: string; ... }
  | { kind: 'color-vibrance'; layerId: string; ... }
  | { kind: 'color-balance'; layerId: string; ... }
  | { kind: 'black-and-white'; layerId: string; ... }
  | { kind: 'color-temperature'; layerId: string; ... }
  | { kind: 'color-invert'; layerId: string; ... }
  | { kind: 'selective-color'; layerId: string; ... }
  | { kind: 'curves'; layerId: string; lutTextures: CurvesLutTextures; ... }

export type RenderPlanEntry =
  | { kind: 'layer'; layer: WebGLLayer; mask?: WebGLLayer }
  | {
      kind: 'adjustment-group'
      parentLayerId: string
      baseLayer: WebGLLayer
      baseMask?: WebGLLayer
      adjustments: ScopedAdjustmentRenderOp[]
    }
```

### Group building in `Canvas`

`buildRenderPlan()` walks `state.layers` and collapses a base raster layer plus its immediately following adjustment children into one `adjustment-group` entry.

Rules:

- text and shape layers remain normal `layer` entries unless the product later supports adjustment children for them
- mask children remain associated with their parent layer as today
- adjustment children always belong to the nearest preceding raster parent with matching `parentId`
- the group preserves child adjustment order, so multiple Curves layers stack correctly

### Group rendering in `WebGLRenderer`

For each `adjustment-group`:

1. Render the base layer into a scratch FBO on transparent background.
2. Apply each visible child adjustment pass to that scratch texture in order.
3. Composite the final group result onto the main accumulation framebuffer using the parent layer's opacity, blend mode, and optional mask.

This model keeps adjustments scoped to the parent layer and automatically makes Curves histogram readback well-defined.

### Curves pass plumbing

`WebGLRenderer.ts` gains:

```ts
private readonly curvesProgram: WebGLProgram
```

and a new method:

```ts
applyCurvesPass(
  srcTex: WebGLTexture,
  dstFb: WebGLFramebuffer,
  luts: CurvesLutTextures,
  selMaskLayer?: WebGLLayer,
): void
```

`CurvesLutTextures` is a small renderer-owned object containing the four uploaded LUT textures for one layer. The renderer may cache them by adjustment layer ID and dispose/re-upload only when the params object identity changes.

### Preview toggle integration

The spec requires Preview to bypass the Curves effect without mutating stored params. That should be implemented through a new ephemeral store:

```ts
src/store/adjustmentPreviewStore.ts
```

Shape:

```ts
{ current: Set<string>; subscribe(): () => void }
```

`CurvesPanel` toggles membership for its layer ID. `Canvas` subscribes, triggers a render, and `buildRenderPlan()` filters matching adjustment ops out of the `adjustments` array for that render only. Closing the panel clears the bypass flag before `captureHistory('Adjustment')` runs.

This keeps Preview out of document state, undo, and file serialization.

---

## Histogram Generation Strategy

### Source pixels

The histogram must represent the pixels entering the currently edited Curves layer, not the already-adjusted output. Under the grouped render model, that means:

- base parent layer content
- plus any earlier visible adjustment siblings on the same parent
- excluding the target Curves layer itself
- excluding later sibling adjustments and unrelated higher layers

Add a canvas-handle method:

```ts
readAdjustmentInputPixels: (adjustmentLayerId: string) => Uint8Array | null
```

Implementation path:

- `Canvas` resolves the relevant `adjustment-group`
- `WebGLRenderer` renders that group into a scratch FBO up to `targetAdjustmentIndex - 1`
- it reads back the full RGBA buffer for histogram computation

### Histogram computation

Histogram calculation is CPU-intensive on large canvases and belongs in WASM per the project architecture.

Add a WASM export that computes all four histograms in one pass:

```ts
interface CurvesHistogramResult {
  rgb: Uint32Array    // 256 bins
  red: Uint32Array
  green: Uint32Array
  blue: Uint32Array
}
```

Algorithm for each non-transparent pixel with effective weight $w$:

- effective weight = `alpha / 255`
- if the Curves layer has a baked selection mask, multiply by `selectionMask / 255`
- `red[r] += w`
- `green[g] += w`
- `blue[b] += w`
- `rgb[r] += w; rgb[g] += w; rgb[b] += w`

The composite RGB histogram intentionally counts all three RGB samples into one 256-bin distribution. This matches common Curves UIs better than a luminance histogram and keeps the master curve visually tied to channel intensity distribution.

### Scheduling and caching

`useCurvesHistogram.ts` owns histogram fetching and should:

- recompute only when the upstream input pixels change or when the edited layer changes
- not recompute on point drag, because curve edits do not change the source histogram
- drop stale async results via a monotonically increasing request token
- cache the most recent result by `(adjustmentLayerId, sourceRevision)`

The widget may normalize bins with a square-root or log-style visual transform at render time for readability, but the stored histogram data remains raw counts.

If histogram generation fails, `CurvesGraph` shows the non-blocking "Histogram unavailable" overlay while the rest of the panel remains functional.

---

## UI Structure

### `CurvesPanel`

**File:** `src/components/panels/CurvesPanel/CurvesPanel.tsx`  
**Category:** panel  
**Single responsibility:** render and dispatch the editable Curves adjustment UI for one `CurvesAdjustmentLayer`.

Props:

```ts
interface CurvesPanelProps {
  layer: CurvesAdjustmentLayer
  parentLayerName: string
  canvasHandleRef: { readonly current: CanvasHandle | null }
}
```

Responsibilities:

- read/write the active Curves layer through `UPDATE_ADJUSTMENT_LAYER`
- own Preview local state and preview-store integration
- call `useCurvesHistogram` and `useCurvesPresets`
- show inline validation banners for paste/preset failures
- mark `ui.presetRef.dirty = true` when manual edits diverge from the linked preset

### `CurvesGraph`

**File:** `src/components/widgets/CurvesGraph/CurvesGraph.tsx`  
**Category:** widget  
**Single responsibility:** render the graph, histogram, control points, axis labels, and pointer/keyboard interactions from props only.

Key props:

```ts
interface CurvesGraphProps {
  channel: CurvesChannel
  points: CurvesControlPoint[]
  histogram: Uint32Array | null
  visualAids: CurvesVisualAids
  selectedPointId: string | null
  hoverTone: { input: number; output: number } | null
  clipping: { low: boolean; high: boolean }
  onAddPoint: (input: number, output: number) => void
  onMovePoint: (pointId: string, input: number, output: number) => void
  onSelectPoint: (pointId: string | null) => void
  onDeletePoint: (pointId: string) => void
  onNudgePoint: (pointId: string, dx: number, dy: number) => void
}
```

Implementation notes:

- Use React pointer/keyboard handlers only. Do not attach raw DOM listeners.
- Throttle drag updates to one reducer dispatch per animation frame by storing the latest pending point position in a ref and flushing inside `requestAnimationFrame`.
- Keep the graph widget props-only; the panel owns the actual reducer dispatch and point validation logic.

### Reusable UI pieces

No new global dialog is needed. The only reusable widget justified here is `CurvesGraph`; the channel buttons, preset dropdown, and action rows are specific enough to remain inside `CurvesPanel`.

---

## Hook and Store Changes

### `useCurvesHistogram`

Single concern: manage histogram readback, async WASM computation, cache invalidation, and fallback state.

### `useCurvesPresets`

Single concern: load/save custom presets from the Electron settings bridge and expose CRUD helpers to `CurvesPanel`.

### `adjustmentPreviewStore`

Single concern: maintain ephemeral preview-bypass IDs for currently open adjustment panels.

### `adjustmentClipboardStore`

Single concern: hold versioned in-app adjustment-settings clipboard payloads separately from pixel clipboard data.

No `AppContext` reducer changes are required beyond adding the new Curves layer type because Curves panel updates still flow through the existing generic `UPDATE_ADJUSTMENT_LAYER` action.

---

## Undo/Redo Behavior

Curves follows the same contract as the other adjustment panels:

- live edits dispatch `UPDATE_ADJUSTMENT_LAYER` immediately for preview
- no history entry is created during point drag, channel switches, preset changes, or copy/paste
- `handleCloseAdjustmentPanel()` captures exactly one history entry labeled `Adjustment`

Additional Curves-specific requirements:

- the history snapshot must include `adjustmentMasks`
- closing the panel while Preview is off must first clear preview bypass, then capture history
- reopening and editing an existing Curves layer, then closing the panel, records one history step that restores the prior Curves params on undo
- undoing creation of a new Curves layer removes the layer and its baked adjustment mask together

---

## Performance Strategy

### Live preview

Curves live preview must remain responsive on large canvases. The design does that by keeping the hot path extremely small:

- point edits regenerate only four 256-entry LUTs on the CPU
- only tiny LUT textures are re-uploaded on each change
- the fragment shader performs at most four LUT lookups plus the optional selection-mask lookup per pixel
- drag updates are coalesced to one reducer dispatch per animation frame

### Histogram performance

Histogram generation is deliberately decoupled from live preview:

- histogram input is read only when the upstream source changes, not on every point drag
- the four histograms are computed in one WASM pass instead of four separate JS loops
- stale requests are discarded instead of blocking newer UI state

### Large-canvas considerations

For documents with multiple stacked adjustment groups and large dimensions:

- reuse existing scratch FBOs instead of allocating per-adjustment temporary framebuffers
- reuse LUT textures per layer ID and update in place
- skip hidden adjustments before entering the pass loop
- drop intermediate drag frames rather than queueing every move event

This meets the spec's degrade-gracefully requirement: the newest drag state wins and input stays responsive even if some intermediate renders are skipped.

---

## Validation and Testing Strategy

### Unit tests

Add deterministic tests for the pure data helpers:

- control-point normalization and endpoint enforcement
- Fritsch-Carlson tangent generation
- 256-entry LUT generation for linear, S-curve, and inverted shapes
- preset equality and `presetRef.dirty` detection
- clipboard payload validation

### Integration tests

Add renderer-facing tests around grouped adjustment rendering and Curves pass wiring:

- Curves identity LUT produces unchanged output
- RGB-only curve modifies all channels equally
- per-channel curves apply after the RGB curve
- selection-scoped Curves only affects masked pixels
- stacked Curves layers apply in state order

The easiest form is a small in-browser test harness that creates a `WebGLRenderer`, builds a tiny synthetic render plan, and asserts on `readFlattenedPlan()` output bytes.

### Persistence tests

Validate that Curves survives:

- `.verve` save and reopen
- tab switch away and back
- undo/redo with `hasMask = true`
- copy/paste settings between two Curves layers
- invalid paste payloads

### Manual validation checklist

- drag points rapidly on a large canvas and confirm the canvas stays interactive
- toggle Preview while dragging and after applying presets
- switch channels and confirm points/histograms preserve per-channel state
- close and reopen the panel; selected channel and visual aids should restore
- apply a custom preset, edit it, save document, reopen document, and confirm `presetRef` and curve shape restore correctly

---

## Implementation Steps

1. Add Curves types and registry defaults in `src/types/index.ts` and `src/adjustments/registry.ts`.
2. Introduce generic adjustment-group render planning in `src/components/window/Canvas/canvasPlan.ts` and `src/webgl/WebGLRenderer.ts`, migrating the existing adjustments onto the grouped path.
3. Extend `canvasHandle.ts`, `useTabs.ts`, `useFileOps.ts`, `useHistory.ts`, and `historyStore.ts` so baked adjustment masks persist across history, tab switches, and `.verve` save/load.
4. Add `adjustmentPreviewStore.ts` and wire `Canvas.tsx` to re-render when preview bypass changes.
5. Implement Curves LUT helpers and `CURVES_FRAG`, then add the `curves` render op and `applyCurvesPass()` in `WebGLRenderer.ts`.
6. Add `readAdjustmentInputPixels()` to `canvasHandle.ts` and the underlying renderer helper that reads the pre-target group output.
7. Add the WASM histogram op and `useCurvesHistogram.ts`.
8. Add `useCurvesPresets.ts`, Electron IPC preset persistence, and `adjustmentClipboardStore.ts`.
9. Implement `CurvesGraph` widget and `CurvesPanel` panel, then register it in `AdjustmentPanel.tsx`.
10. Validate identity rendering, mask persistence, preset persistence, and undo/redo before considering the feature complete.

---

## Architectural Constraints

- `App.tsx` remains a thin orchestrator. It may pass `canvasHandleRef` into `AdjustmentPanel`, but Curves business logic belongs in `CurvesPanel`, `useCurvesHistogram`, and `useCurvesPresets`.
- `CurvesGraph` is a widget and must remain props-only. It must not read `AppContext`.
- The render-path change belongs in the renderer/canvas layer, not inside the panel. UI code must not manipulate WebGL resources directly.
- WASM access must go through `src/wasm/index.ts`; nothing imports from `src/wasm/generated/` directly.
- Preview uses a dedicated ephemeral store, not serialized AppState, because it is render-only session state.

---

## Rollout Considerations

No user-facing phased rollout is recommended. Shipping Curves without grouped rendering or adjustment-mask persistence would violate the approved spec.

The only reasonable internal sequencing is:

1. Land the generic adjustment-group renderer and adjustment-mask persistence path.
2. Land Curves UI, LUT pass, histogram, and preset support on top of that foundation.

This is an implementation sequence, not a product phase split.

---

## Open Questions

1. **Grouped adjustment rendering for all existing adjustments.** Curves needs parent-scoped rendering, and the clean implementation migrates all current adjustments onto that path. This is the recommended approach. Reusing the current full-screen accumulated-composite path would be faster to code but incorrect for child-layer semantics.
2. **Preset-link UX after edits.** This design stores `presetRef.dirty` so the panel can show that the layer originated from a preset but no longer matches it. If the product prefers simpler UX, the link can be cleared entirely on the first manual edit. The stored data model supports either presentation.
3. **Histogram weighting with layer masks.** This design weights histogram input by alpha and the Curves baked selection mask. If the parent layer later gains a paintable layer mask, the histogram should also respect that mask so the displayed input matches visible pixels. The grouped renderer makes that straightforward, but the exact weighting should be confirmed during implementation.