# Technical Design: Indexed Color Mode

## Overview

Indexed Color Mode is the user-facing layer built on top of the `indexed8` pixel format defined in the
[Pixel Format Abstraction](pixel-format-abstraction.md) technical design. That foundation provides everything
architectural: `GpuLayer.format`, `createLayer()` with the `format` parameter, `flushLayer()` with palette
expansion, `AppState.pixelFormat`, `SET_PIXEL_FORMAT`, `.verve` v5 serialization, the Image → Color Mode
menu, and adjustment/filter gating. **This design covers only the new work specific to indexed mode
workflows**: tool handler branches, the palette-only color picker widget, new-layer 255-fill, merge/flatten
re-quantization, nearest-neighbor enforcement for transforms, status bar pixel info, and swatch management
guards.

Index 255 is the void/transparent sentinel throughout. It is unconditional, not user-configurable.

---

## Affected Areas

| File | Change |
|---|---|
| `src/tools/types.ts` | Add `pixelFormat: PixelFormat` and `swatches: readonly RGBAColor[]` to `ToolContext` |
| `src/ux/main/Canvas/Canvas.tsx` | Thread `pixelFormat` + `swatches` into `buildCtx()`; 255-fill for indexed8 new blank layers in `init()`; swatch-change re-flush effect for indexed8 |
| `src/utils/indexedColorUtils.ts` | **New.** Pure-TS helpers: `resolveNearestPaletteIndex`, `writeIndexToLayer`, `stampIndexedShape` |
| `src/tools/pencil.tsx` | Indexed8 draw branch: resolve index once on `pointerDown`, write via `writeIndexToLayer` per pixel; pixel brush per-stamp index resolve; no blending |
| `src/tools/eraser.tsx` | Indexed8 erase branch: write 255 via `stampIndexedShape`; no alpha blending |
| `src/tools/fill.tsx` | Indexed8 flood fill: new WASM `floodFillIndexed` for contiguous; TS scan for non-contiguous |
| `src/tools/eyedropper.tsx` | Indexed8 sample: read raw index from `layer.data`, set primary to palette color; dispatch `SET_ACTIVE_SWATCH` |
| `src/tools/magicWand.tsx` | Indexed8 canvas buffer: expand indices to palette RGBA; force tolerance=0 |
| `src/ux/widgets/IndexedPaletteColorPicker/IndexedPaletteColorPicker.tsx` | **New.** Palette grid picker widget |
| `src/ux/widgets/IndexedPaletteColorPicker/IndexedPaletteColorPicker.module.scss` | **New.** Styles |
| `src/ux/main/Toolbar/Toolbar.tsx` | Render `IndexedPaletteColorPicker` popover instead of `ColorPickerDialog` when `pixelFormat === 'indexed8'` |
| `src/core/services/useTransform.ts` | Force `nearest` interpolation for indexed8 layers; re-quantize RGBA transform result to indices via `matchPaletteIndices` |
| `src/core/services/useCanvasTransforms.ts` | Resize image, resize canvas, crop: indexed8-specific paths using raw index buffers |
| `src/core/services/useLayers.ts` | Merge and flatten: expand → composite (existing) → requantize via `matchPaletteIndices`; call `prepareNewLayerIndexed` |
| `src/ux/main/Canvas/canvasHandle.ts` | `getLayerPixels` and `writeLayerPixels` indexed8 branches; new `getLayerIndexData`, `prepareNewLayerIndexed`, `writeLayerIndexData` methods on `CanvasHandle` |
| `src/core/store/cursorStore.ts` | Add `pixelInfo: IndexedPixelInfo \| null` field |
| `src/ux/main/StatusBar/StatusBar.tsx` | Display `idx N · #RRGGBB` when `pixelFormat === 'indexed8'` and cursor visible |
| `src/ux/main/RightPanel/Swatch/SwatchPanel.tsx` | Block last-swatch deletion, warn on index-shifting deletion, disable drag-reorder in indexed8 mode |
| `wasm/src/pixelops.cpp` | New `floodFillIndexed` C++ function |
| `wasm/CMakeLists.txt` | Append `_floodFillIndexed` to `-sEXPORTED_FUNCTIONS` |
| `src/wasm/types.ts` | New `floodFillIndexed` WASM signature |
| `src/wasm/index.ts` | New `floodFillIndexed` high-level wrapper |
| `src/ux/index.ts` | Export `IndexedPaletteColorPicker` |

---

## State Changes

No new `AppState` fields. `AppState.pixelFormat` and `GpuLayer.format` are provided by the foundation.

### `src/core/store/cursorStore.ts`

Add a `pixelInfo` slot for indexed-mode pixel display in the status bar:

```ts
export interface IndexedPixelInfo {
  index: number          // raw palette index at cursor (may be 255 for void)
  r: number; g: number; b: number  // expanded palette RGBA (0,0,0 for void)
}
```

Add `pixelInfo: IndexedPixelInfo | null = null` as a public field alongside the existing `x, y, visible`
fields. Add a `setPixelInfo(info: IndexedPixelInfo | null): void` method that sets the field and calls
`this.notify()`.

---

## New Components / Hooks / Utilities

### `src/utils/indexedColorUtils.ts`

**Category:** Utility (pure TS, no React)  
**Responsibility:** Shared helpers for indexed-mode drawing operations. Imported by tool handlers.

```ts
/**
 * Find the palette index with smallest RGBA Euclidean distance to (r,g,b,a).
 * Returns 255 if the palette is empty.
 * On a tie in distance, the lower index wins.
 */
export function resolveNearestPaletteIndex(
  r: number, g: number, b: number, a: number,
  palette: readonly RGBAColor[],
): number

/**
 * Write a single palette index into layer.data at the given canvas coordinate.
 * Applies selection mask and tiled-mode wrapping.
 * Returns true if the write was performed, false if gated out (off-bounds, masked).
 */
export function writeIndexToLayer(
  layer: GpuLayer,
  canvasX: number,
  canvasY: number,
  index: number,
  sel?: { mask: Uint8Array; width: number },
  tiledW?: number,
  tiledH?: number,
): boolean

/**
 * Stamp a size×size footprint at canvas (cx, cy) using the given shape.
 * Calls writeIndexToLayer for each pixel inside the shape boundary.
 */
export function stampIndexedShape(
  layer: GpuLayer,
  cx: number,
  cy: number,
  index: number,
  size: number,
  shape: 'round' | 'square' | 'diamond',
  touched: Map<number, true>,
  sel?: { mask: Uint8Array; width: number },
  tiledW?: number,
  tiledH?: number,
): void

/**
 * Expand a 1-byte-per-pixel indexed Uint8Array into a 4-byte-per-pixel RGBA buffer.
 * Out-of-range indices and 255 map to [0,0,0,0].
 */
export function expandIndicesToRgba(
  indexData: Uint8Array,
  palette: readonly RGBAColor[],
): Uint8Array
```

`writeIndexToLayer` mirrors the bounds-check + selection-mask logic from `blendPixelOver` in
`primitives.ts`, but writes one byte to `layer.data[ly * layer.layerWidth + lx]` instead of
blending RGBA. The touched map key is `canvasY * canvasWidth + canvasX` (consistent with the
existing per-stroke coverage map convention).

`stampIndexedShape` replicates the bounding-box loop from `paintBrushStamp` but calls
`writeIndexToLayer`. Each pixel is only written if it is not already in `touched` (write-once
per stroke).

---

### `src/ux/widgets/IndexedPaletteColorPicker/IndexedPaletteColorPicker.tsx`

**Category:** Widget  
**Responsibility:** A self-contained palette grid picker that replaces the RGBA color picker when
`pixelFormat === 'indexed8'`. Displays palette entries as square cells in a 10-column grid.

**Props:**

```ts
interface IndexedPaletteColorPickerProps {
  palette: readonly RGBAColor[]   // document swatch palette, index order
  activeIndex: number             // index currently resolved for the active color (-1 if none)
  onSelect: (index: number, color: RGBAColor) => void
  onClose: () => void
}
```

**Rendering:** Title bar with "Color Palette" label and an "Indexed/8" mode badge. Body: a `pp-grid`
(10 columns, `gap: 2px`). Each cell is one palette entry rendered as a filled square. The cell
matching `activeIndex` carries the `.pp-active` ring. Footer shows a larger swatch preview, the
index number, and the hex value for the currently hovered (or active) cell.

On hover the footer updates to reflect the hovered entry (index + hex) without confirming. On
click, `onSelect(index, color)` is called and the picker closes via `onClose()`.

The component renders into a portal (matching the existing pattern from `EmbedColorPicker`) so it
floats above the toolbar.

**No hex entry, hue ring, or RGBA sliders.** The component must contain no free-form color input.

---

## Implementation Steps

### Step 1 — Extend `ToolContext` with `pixelFormat` and `swatches`

**File:** `src/tools/types.ts`

Add two fields to `ToolContext`:

```ts
/** Document pixel format — tools branch on this to select rgba8 vs indexed8 behavior. */
pixelFormat: PixelFormat
/** Current swatch palette — required by indexed8 drawing tools for nearest-index resolution. */
swatches: readonly RGBAColor[]
```

**File:** `src/ux/main/Canvas/Canvas.tsx`

In `buildCtx()`, populate both fields:

```ts
pixelFormat: state.pixelFormat,
swatches: state.swatches,
```

`swatchesRef.current` is already kept in sync with `state.swatches`. Use `swatchesRef.current` (not
`state.swatches` directly) inside `buildCtx` so it reflects the latest value at pointer-event time
without stale closure risk.

---

### Step 2 — New blank layer 255-fill in indexed8 mode

**File:** `src/ux/main/Canvas/Canvas.tsx` — in the `init()` effect, at the "new blank layer" branch:

```ts
// existing:
layer = renderer.createLayer(ls.id, ls.name, initW, initH, ox, oy)

// add after:
if (state.pixelFormat === 'indexed8') {
  layer.data.fill(255)   // all pixels are void/transparent sentinel
}
```

`renderer.createLayer(…, 'indexed8')` produces a `Uint8Array(w*h)` initialized to zero. Filling
with 255 makes the layer fully transparent as required. The call to `renderer.flushLayer(layer,
state.swatches)` that follows uploads the correct expansion.

This same fill applies to the background layer when a new document is created in indexed8 mode.
For `backgroundFill === 'white'` or `'black'`, a new document in indexed8 mode still fills with
255 — a white or black background index does not exist until a swatch provides it. If the document
starts in indexed8 mode (e.g. from a future "new indexed document" dialog), all pixels should start
as void.

---

### Step 3 — Swatch-change re-flush for indexed8 layers

**File:** `src/ux/main/Canvas/Canvas.tsx`

Add an effect that watches `state.swatches` and, when `state.pixelFormat === 'indexed8'`,
re-flushes every GPU layer that has `format === 'indexed8'`:

```ts
useEffect(() => {
  if (state.pixelFormat !== 'indexed8') return
  const renderer = rendererRef.current
  if (!renderer) return
  for (const gl of glLayersRef.current.values()) {
    if (gl.format === 'indexed8') {
      renderer.flushLayer(gl, state.swatches)
    }
  }
  renderFromPlan()
}, [state.swatches])
```

This is the palette-relinking mechanism: swatch edits reflect on screen immediately without
modifying any layer's `data` bytes.

---

### Step 4 — Pencil tool: indexed8 draw branch

**File:** `src/tools/pencil.tsx`

In `createPencilHandler()`, add a module-level `let strokeIndex: number | null = null` (index
resolved once per stroke) and `let indexedTouched: Map<number, true> | null = null`.

**`onPointerDown` in indexed8 mode:**

1. Detect `ctx.layer.format === 'indexed8'`.
2. Resolve `strokeIndex = resolveNearestPaletteIndex(r, g, b, a, ctx.swatches)` from
   `ctx.primaryColor`.
3. If the resolved color differs from the raw primary, dispatch
   `SET_PRIMARY_COLOR` with `ctx.swatches[strokeIndex]` so the toolbar swatch indicator updates to
   the snapped color.
4. Initialize `indexedTouched = new Map()`.
5. Write the index at the cursor pixel via `writeIndexToLayer` (size=1) or `stampIndexedShape`
   (size>1).
6. Call `renderer.flushLayer(layer, ctx.swatches)` then `render()`.

**`onPointerMove` in indexed8 mode (size=1, no pixel-brush):**

Walk the Bresenham line from last position to current. For each pixel:
- Pixel-perfect mode off: call `writeIndexToLayer(layer, px, py, strokeIndex!, …, indexedTouched!)`.
- Pixel-perfect mode on: feed pixels through the `addPPPixel` / L-corner logic, but the eventual
  write call is `writeIndexToLayer(…, strokeIndex!)`. L-corner pixels that are suppressed instead
  receive index 255 (void): `writeIndexToLayer(layer, lcp.x, lcp.y, 255, …, indexedTouched!)`.

**`onPointerMove` in indexed8 mode (size>1):**

Use the smoothing EMA to compute the bezier control path exactly as today (smoothing remains
active per the spec), but replace `paint(…)` with an indexed stamp path: instead of
`walkQuadBezier`, compute interpolated sample points along the bezier and call `stampIndexedShape`
at each point. The step density follows the same dab-spacing logic used by the existing thick
path (one stamp per half-size pixels of travel).

**Pixel brush in indexed8 mode:**

For each RGBA pixel in the brush template with `a > 0`, resolve
`resolveNearestPaletteIndex(bR, bG, bB, bA, ctx.swatches)` for the brush pixel and write that
index via `writeIndexToLayer`. Brush pixels with `a === 0` are skipped.

**What changes vs. rgba8 path:**

- `blendPixelOver` is never called in the indexed8 path.
- `pencilOptions.opacity` is not read (implied 100%).
- `pencilOptions.antiAlias` is not read (no fractional coverage).
- `touched: Map<number, number>` (opacity coverage map) is not used; `indexedTouched:
  Map<number, true>` is used instead (write-once semantics).

**`onPointerUp`:** Clear `strokeIndex = null` and `indexedTouched = null`.

**Options UI in indexed8 mode:** Gray out and disable the opacity slider and anti-alias toggle.
These controls check `ctx.pixelFormat === 'indexed8'` — but since the options UI is a React
component without direct access to `ToolContext`, read `pixelFormat` from `AppContext` via
`useAppContext()` in the options component.

---

### Step 5 — Eraser tool: indexed8 erase branch

**File:** `src/tools/eraser.tsx`

In `createEraserHandler()` inside `stamp()`, detect `ctx.layer.format === 'indexed8'`.

Indexed8 erase path:
1. `growLayerToFit` as today.
2. Create `touched: Map<number, true>` (write-once per stroke).
3. Walk the Bresenham segment from `(x0,y0)` to `(x1,y1)`.
4. At each step, call `stampIndexedShape(layer, px, py, 255, eraserOptions.size, 'round', touched,
   sel, tiledW, tiledH)`.
5. Call `renderer.flushLayer(layer, ctx.swatches)` then `render()`.

The erase path does not read `eraserOptions.strength`, `eraserOptions.antiAlias`, or
`eraserOptions.alphaMode` — all are no-ops for indexed erase. `eraserOptions.size` remains active.

**Options UI:** Gray out and disable strength, anti-alias, and alpha-mode controls in indexed8 mode.
Read `pixelFormat` from `useAppContext()`.

---

### Step 6 — Fill tool: indexed8 flood fill

**File:** `wasm/src/pixelops.cpp`

Add a new `floodFillIndexed` function:

```cpp
extern "C" EMSCRIPTEN_KEEPALIVE
void floodFillIndexed(
  uint8_t* indices,    // layer-local 1 byte/pixel buffer, modified in-place
  int w, int h,
  int startX, int startY,
  uint8_t fillIndex    // index to write (0–254); 255 = void
) {
  // BFS 4-connected flood fill, matching pixels equal to indices[startY*w+startX]
  // Skips write if fillIndex equals the target index (no-op region)
}
```

Append `_floodFillIndexed` to the `-sEXPORTED_FUNCTIONS` list in `wasm/CMakeLists.txt`.

**`src/wasm/types.ts`:** Add the signature:
```ts
floodFillIndexed(indices: number, w: number, h: number, startX: number, startY: number, fillIndex: number): void
```

**`src/wasm/index.ts`:** Add the wrapper:
```ts
export async function floodFillIndexed(
  indices: Uint8Array,
  w: number, h: number,
  startX: number, startY: number,
  fillIndex: number,
): Promise<Uint8Array>
```

Uses the standard `withInPlaceBuffer` pattern.

**File:** `src/tools/fill.tsx` — in `createFillHandler().onPointerDown`, after the existing rgba8
guards, add:

```ts
if (ctx.layer.format === 'indexed8') {
  const strokeIndex = resolveNearestPaletteIndex(r, g, b, a, ctx.swatches)
  const lx = Math.floor(x) - layer.offsetX
  const ly = Math.floor(y) - layer.offsetY

  if (fillOptions.contiguous) {
    floodFillIndexed(
      layer.data.slice() as Uint8Array,
      layer.layerWidth, layer.layerHeight,
      lx, ly, strokeIndex,
    ).then(result => {
      layer.data.set(result)
      applySelectionMask()          // selection guard using the indexed variant
      renderer.flushLayer(layer, ctx.swatches)
      render(layers)
      commitStroke('Fill')
    })
  } else {
    // Non-contiguous: replace all occurrences of target index
    const targetIndex = (layer.data as Uint8Array)[ly * layer.layerWidth + lx]
    for (let i = 0; i < layer.data.length; i++) {
      if ((layer.data as Uint8Array)[i] === targetIndex) {
        (layer.data as Uint8Array)[i] = strokeIndex
      }
    }
    applySelectionMask()
    renderer.flushLayer(layer, ctx.swatches)
    render(layers)
    commitStroke('Fill')
  }
  return
}
```

The `applySelectionMask()` closure in the indexed8 branch uses a 1-byte-per-pixel snapshot of
`layer.data` taken before the fill, and restores bytes for masked-out pixels (same logic as the
rgba8 path but indexing at `i` not `i*4`).

---

### Step 7 — Eyedropper tool: indexed8 sample branch

**File:** `src/tools/eyedropper.tsx`

Replace `sampleArea(…)` in the indexed8 path:

```ts
function sampleIndexedPixel(layers: GpuLayer[], canvasX: number, canvasY: number): {
  index: number; color: RGBAColor
} | null {
  // Walk layers top-to-bottom (already ordered by caller)
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]
    if (!layer.visible || layer.format !== 'indexed8') continue
    const lx = canvasX - layer.offsetX
    const ly = canvasY - layer.offsetY
    if (lx < 0 || lx >= layer.layerWidth || ly < 0 || ly >= layer.layerHeight) continue
    const index = (layer.data as Uint8Array)[ly * layer.layerWidth + lx]
    return { index, color: ... }   // color resolved from ctx.swatches below
  }
  return null
}
```

In `createEyedropperHandler().pick()`:

```ts
if (layers.some(l => l.format === 'indexed8')) {
  const cx = Math.floor(pos.x), cy = Math.floor(pos.y)
  const result = sampleIndexedPixel(layers, cx, cy)
  if (!result || result.index === 255 || result.index >= ctx.swatches.length) {
    ctx.setColor({ r: 0, g: 0, b: 0, a: 0 })
    ctx.dispatch({ type: 'SET_ACTIVE_SWATCH', payload: -1 })  // deselect
  } else {
    ctx.setColor(ctx.swatches[result.index])
    ctx.dispatch({ type: 'SET_ACTIVE_SWATCH', payload: result.index })
  }
  return
}
// else fall through to existing rgba compositing path
```

`ctx.dispatch` needs to be threaded into `ToolContext` (add `dispatch: Dispatch<AppAction>` to the
interface — see note below). The `SET_ACTIVE_SWATCH` action highlights the corresponding swatch in
the Swatches panel. If that action does not yet exist, add it to `AppContext.tsx` and `AppState`
(`activePaletteIndex: number`).

> **Note on `dispatch` in ToolContext:** The eyedropper is currently the only tool that needs to
> dispatch. Rather than threading all of dispatch, add a targeted callback:
> `setSwatch: (index: number) => void` to `ToolContext`. Canvas.tsx populates it with
> `(i) => dispatch({ type: 'SET_ACTIVE_SWATCH', payload: i })`. This keeps `ToolContext` narrow.

`eyedropperOptions.sampleSize` is not used in indexed mode (point sampling only; averaging
indices would be meaningless). The sample-size selector in the options UI should be grayed out in
indexed8 mode.

---

### Step 8 — Magic Wand: indexed8 canvas buffer

**File:** `src/tools/magicWand.tsx`

In `createMagicWandHandler().onPointerDown`, detect `ctx.layer.format === 'indexed8'` and build the
canvas-sized RGBA buffer differently:

```ts
if (ctx.layer.format === 'indexed8') {
  // Expand index bytes → palette RGBA for the canvas buffer
  const expandedLayer = expandIndicesToRgba(layer.data as Uint8Array, ctx.swatches)
  for (let ly2 = 0; ly2 < lh; ly2++) {
    const cy2 = oy + ly2
    if (cy2 < 0 || cy2 >= ch) continue
    for (let lx2 = 0; lx2 < lw; lx2++) {
      const cx2 = ox + lx2
      if (cx2 < 0 || cx2 >= cw) continue
      const si = (ly2 * lw + lx2) * 4  // from expanded buffer
      const di = (cy2 * cw + cx2) * 4
      canvasData[di]     = expandedLayer[si]
      canvasData[di + 1] = expandedLayer[si + 1]
      canvasData[di + 2] = expandedLayer[si + 2]
      canvasData[di + 3] = expandedLayer[si + 3]
    }
  }
  // Force tolerance=0: same-index pixels have identical RGBA, so RGBA distance=0
  selectionStore.floodFillSelect(x, y, canvasData, 0, wandOptions.contiguous, mode, …)
  return
}
// else existing 4-byte RGBA copy path
```

Using the palette-expanded RGBA with tolerance=0 is semantically equivalent to comparing by index
value: pixels with the same index expand to identical RGBA, so they will all be selected. No changes
to `floodFillSelect` are required.

**Options UI:** Gray out and disable the tolerance slider in indexed8 mode. Read `pixelFormat` from
`useAppContext()`.

---

### Step 9 — Palette-only color picker in Toolbar

**File:** `src/ux/main/Toolbar/Toolbar.tsx`

The foreground/background swatch buttons currently call `openPicker('fg' | 'bg')` which opens
`ColorPickerDialog` (modal). In indexed8 mode, replace the dialog with the inline
`IndexedPaletteColorPicker` popover.

Add state:
```ts
const [indexedPickerTarget, setIndexedPickerTarget] = useState<'fg' | 'bg' | null>(null)
```

Modify `openPicker`:
```ts
const openPicker = (target: 'fg' | 'bg'): void => {
  if (state.pixelFormat === 'indexed8') {
    setIndexedPickerTarget(target)
    return
  }
  setDialogTarget(target)
  setDialogOpen(true)
}
```

Mount the picker when `indexedPickerTarget !== null`:
```tsx
{indexedPickerTarget !== null && (
  <IndexedPaletteColorPicker
    palette={state.swatches}
    activeIndex={resolveNearestPaletteIndex(
      indexedPickerTarget === 'fg' ? state.primaryColor.r   : state.secondaryColor.r,
      indexedPickerTarget === 'fg' ? state.primaryColor.g   : state.secondaryColor.g,
      indexedPickerTarget === 'fg' ? state.primaryColor.b   : state.secondaryColor.b,
      indexedPickerTarget === 'fg' ? state.primaryColor.a   : state.secondaryColor.a,
      state.swatches,
    )}
    onSelect={(idx, color) => {
      dispatch({
        type: indexedPickerTarget === 'fg' ? 'SET_PRIMARY_COLOR' : 'SET_SECONDARY_COLOR',
        payload: color,
      })
      setIndexedPickerTarget(null)
    }}
    onClose={() => setIndexedPickerTarget(null)}
  />
)}
```

`resolveNearestPaletteIndex` is imported from `src/utils/indexedColorUtils.ts`.

---

### Step 10 — Free Transform: nearest-neighbor enforcement

**File:** `src/core/services/useTransform.ts`

In `handleApply()`, after reading `interpolation` from `transformStore`, override for indexed8:

```ts
const { params, handleMode, interpolation, floatBuffer, originalW, originalH, layerId } = transformStore
const layer = handle.getGpuLayer(layerId)           // new CanvasHandle method — see below
const isIndexed = layer?.format === 'indexed8'
const effectiveInterp = isIndexed ? 'nearest' : interpolation
const interpInt = interpToInt(effectiveInterp)
```

After the WASM affine/perspective transform returns a canvas-sized RGBA `result`, add a
re-quantization step for indexed8:

```ts
if (isIndexed) {
  const swatches = stateRef.current.swatches
  const indexResult = await matchPaletteIndices(result, swatches, 255)
  handle.writeLayerIndexData(layerId, indexResult)
} else {
  handle.writeLayerPixels(layerId, result)
}
```

`matchPaletteIndices` is from `src/wasm/index.ts` (defined in the foundation tech design).
`handle.writeLayerIndexData` is a new `CanvasHandle` method (see Step 12).

`transformStore.floatBuffer` is populated by `handleEnterTransform` via `handle.getLayerPixels(layerId)`.
For indexed8, `getLayerPixels` must return the expanded RGBA representation (not raw indices) so the
WASM transform receives valid RGBA input. The indexed8 branch of `getLayerPixels` is covered in Step 12.

**`transformStore` reset**: `transformStore.clear()` sets `interpolation` back to `'bilinear'`. This
is unaffected — the indexed8 override happens at `handleApply` call time, not at store level.

**Options UI:** In `TransformOptions`, gray out and lock the interpolation selector to "Nearest
Neighbour" when `pixelFormat === 'indexed8'`. Read `pixelFormat` from `useAppContext()`.

---

### Step 11 — Resize image, resize canvas, crop: indexed8 paths

**File:** `src/core/services/useCanvasTransforms.ts`

All three operations currently read per-layer pixels via `handle.getLayerPixels()` (RGBA),
manipulate them, and store results as PNG data URLs in `pendingLayerData`. For indexed8, the raw
index buffer must be preserved through these operations; the PNG round-trip is incorrect for index
data.

Add a helper to detect the active format:
```ts
const isIndexed = stateRef.current.pixelFormat === 'indexed8'
```

#### Resize image (`handleResizeImage`)

In the indexed8 path:
1. For each pixel layer, call `handle.getLayerIndexData(layer.id)` → `Uint8Array | null`.
2. The current layer dimensions equal the pre-resize canvas dimensions.
3. Expand indices to RGBA: `const rgba = expandIndicesToRgba(indexData, swatches)`.
4. Resize with `resizeNearest(rgba, oldW, oldH, newW, newH)`.
5. Re-quantize: `const resizedIndices = await matchPaletteIndices(resized, swatches, 255)`.
6. Encode as `data:raw/indexed8;base64,<base64 of resizedIndices>`.
7. Store in `encoded` map instead of PNG data URL.

`swatches` is read from `stateRef.current.swatches` at the time of the resize. `expandIndicesToRgba`
is from `indexedColorUtils.ts`.

The expand → resizeNearest → quantize flow is lossless under nearest-neighbor because each output
pixel is a verbatim copy of one source pixel: the two-step palette conversion (expand then
re-quantize) round-trips without error when no interpolation occurs.

#### Resize canvas (`handleResizeCanvas`)

Current path uses `HTMLCanvasElement.drawImage` which only understands RGBA. For indexed8:

1. For each pixel layer, call `handle.getLayerIndexData(layer.id)` → `Uint8Array`.
2. Create output `Uint8Array(newW * newH)` filled with `255` (void/transparent default).
3. Copy the intersection of old canvas and new canvas from old index buffer to new:
   ```ts
   const copyX = Math.max(0, offsetX), copyY = Math.max(0, offsetY)
   const copyW = Math.min(oldW, newW - offsetX) - copyX
   const copyH = Math.min(oldH, newH - offsetY) - copyY
   for (let row = 0; row < copyH; row++) {
     const srcOffset = (copyY + row - offsetY) * oldW + (copyX - offsetX)
     const dstOffset = (copyY + row) * newW + copyX
     newIndices.set(indexData.subarray(srcOffset, srcOffset + copyW), dstOffset)
   }
   ```
4. Encode as `data:raw/indexed8;base64,<base64>`.

New area (outside the old canvas) is naturally filled with 255 from the `fill(255)` initialization.

#### Crop (`handleCrop`)

1. `handle.getLayerIndexData(layer.id)` → `Uint8Array`.
2. Allocate `Uint8Array(cropW * cropH)` filled with `255`.
3. For each row in the crop region that falls within the old canvas:
   ```ts
   for (let row = 0; row < cropH; row++) {
     const srcRow = cropY + row
     if (srcRow < 0 || srcRow >= oldH) continue
     for (let col = 0; col < cropW; col++) {
       const srcCol = cropX + col
       if (srcCol < 0 || srcCol >= oldW) continue
       dst[row * cropW + col] = src[srcRow * oldW + srcCol]
     }
   }
   ```
4. Encode as `data:raw/indexed8;base64,<base64>`.

#### Loading `data:raw/indexed8;base64,...` in Canvas init

**File:** `src/ux/main/Canvas/Canvas.tsx`

In the `init()` effect, where `initialLayerData` / `pendingLayerData` is decoded, add an indexed8
branch alongside the existing PNG and `data:raw/f32` branches (already specified in the foundation
design). For `data:raw/indexed8;base64,...` entries:

```ts
} else if (pngData.startsWith('data:raw/indexed8;base64,')) {
  const b64 = pngData.slice('data:raw/indexed8;base64,'.length)
  const raw  = atob(b64)
  const arr  = new Uint8Array(raw.length)
  for (let k = 0; k < raw.length; k++) arr[k] = raw.charCodeAt(k)
  layer.data.set(arr)
}
```

For this to work, `renderer.createLayer(ls.id, ls.name, lw, lh, ox, oy, 'indexed8')` must be
called for indexed8 documents. `pixelFormat` is now in scope from `state.pixelFormat`.

---

### Step 12 — CanvasHandle: format-aware pixel access methods

**File:** `src/ux/main/Canvas/canvasHandle.ts`

#### `getLayerPixels` — indexed8 branch

The existing implementation reads `layer.data` at 4-byte offsets. For indexed8, the data is 1 byte
per pixel. Add a branch at the top:

```ts
if (layer.format === 'indexed8') {
  // Expand indices to a canvas-sized RGBA buffer
  const w = renderer.pixelWidth, h = renderer.pixelHeight
  const result = new Uint8Array(w * h * 4)
  for (let ly2 = 0; ly2 < layer.layerHeight; ly2++) {
    const cy2 = layer.offsetY + ly2
    if (cy2 < 0 || cy2 >= h) continue
    for (let lx2 = 0; lx2 < layer.layerWidth; lx2++) {
      const cx2 = layer.offsetX + lx2
      if (cx2 < 0 || cx2 >= w) continue
      const idx = (layer.data as Uint8Array)[ly2 * layer.layerWidth + lx2]
      const di = (cy2 * w + cx2) * 4
      if (idx < swatchesRef.current.length) {
        const p = swatchesRef.current[idx]
        result[di] = p.r; result[di+1] = p.g; result[di+2] = p.b; result[di+3] = p.a
      }
      // else: leaves [0,0,0,0] — transparent for void/out-of-range
    }
  }
  return result
}
```

#### `writeLayerPixels` — indexed8 branch

For indexed8 layers, `writeLayerPixels` is called from the transform apply path with an RGBA result.
It must re-quantize to indices before writing:

```ts
if (layer.format === 'indexed8') {
  // pixels is canvas-size RGBA — quantize to indices via WASM, then write layer-local
  matchPaletteIndices(pixels, swatchesRef.current, 255).then(indices => {
    // Copy layer-local region from canvas-sized index buffer
    for (let ly2 = 0; ly2 < layer.layerHeight; ly2++) {
      for (let lx2 = 0; lx2 < layer.layerWidth; lx2++) {
        const ci = (layer.offsetY + ly2) * w + (layer.offsetX + lx2)
        ;(layer.data as Uint8Array)[ly2 * layer.layerWidth + lx2] = indices[ci]
      }
    }
    renderer.flushLayer(layer, swatchesRef.current)
    renderFromPlan()
  })
  return
}
```

Because `matchPaletteIndices` is async, `writeLayerPixels` becomes partially async for indexed8.
Callers (`handleApply` in `useTransform`) already await or handle this via the async chain. This is
acceptable because the transform apply path is already async (WASM call).

#### New method: `getLayerIndexData(layerId: string): Uint8Array | null`

Returns the raw index buffer for an indexed8 layer as a canvas-sized `Uint8Array`
(1 byte per pixel, 255 for off-layer positions):

```ts
getLayerIndexData: (layerId) => {
  const layer = glLayersRef.current.get(layerId)
  if (!layer || layer.format !== 'indexed8') return null
  const w = rendererRef.current!.pixelWidth
  const h = rendererRef.current!.pixelHeight
  const result = new Uint8Array(w * h).fill(255)  // default void for off-layer
  for (let ly2 = 0; ly2 < layer.layerHeight; ly2++) {
    for (let lx2 = 0; lx2 < layer.layerWidth; lx2++) {
      const cx2 = layer.offsetX + lx2, cy2 = layer.offsetY + ly2
      if (cx2 < 0 || cx2 >= w || cy2 < 0 || cy2 >= h) continue
      result[cy2 * w + cx2] = (layer.data as Uint8Array)[ly2 * layer.layerWidth + lx2]
    }
  }
  return result
},
```

Add the signature to the `CanvasHandle` interface.

#### New method: `prepareNewLayerIndexed(layerId: string, name: string, indexData: Uint8Array): void`

Used by `useLayers` after merge/flatten in indexed8 mode. Creates a full-canvas indexed8 GPU layer:

```ts
prepareNewLayerIndexed: (layerId, name, indexData) => {
  const renderer = rendererRef.current
  if (!renderer) return
  const w = renderer.pixelWidth, h = renderer.pixelHeight
  const layer = renderer.createLayer(layerId, name, w, h, 0, 0, 'indexed8')
  ;(layer.data as Uint8Array).set(indexData)
  renderer.flushLayer(layer, swatchesRef.current)
  glLayersRef.current.set(layerId, layer)
  renderFromPlan()
},
```

Add the signature to `CanvasHandle`.

#### New method: `writeLayerIndexData(layerId: string, indexData: Uint8Array): void`

Writes a canvas-sized index buffer into an indexed8 layer without quantization (used post-transform):

```ts
writeLayerIndexData: (layerId, indexData) => {
  const layer = glLayersRef.current.get(layerId)
  const renderer = rendererRef.current
  if (!layer || !renderer || layer.format !== 'indexed8') return
  const w = renderer.pixelWidth
  for (let ly2 = 0; ly2 < layer.layerHeight; ly2++) {
    for (let lx2 = 0; lx2 < layer.layerWidth; lx2++) {
      const ci = (layer.offsetY + ly2) * w + (layer.offsetX + lx2)
      ;(layer.data as Uint8Array)[ly2 * layer.layerWidth + lx2] = indexData[ci]
    }
  }
  renderer.flushLayer(layer, swatchesRef.current)
  renderFromPlan()
},
```

Add to `CanvasHandle`.

#### New method: `getGpuLayer(layerId: string): GpuLayer | null`

Returns the `GpuLayer` object from the `glLayersRef` map. Used by `useTransform` to check
`layer.format`.

```ts
getGpuLayer: (layerId) => glLayersRef.current.get(layerId) ?? null,
```

Add to `CanvasHandle`.

---

### Step 13 — Merge and Flatten in indexed8 mode

**File:** `src/core/services/useLayers.ts`

Each merge operation (`handleMergeSelected`, `handleMergeDown`, `handleMergeVisible`,
`handleFlattenImage`) currently:
1. Calls `handle.rasterizeLayers(…)` or `handle.rasterizeComposite('flatten')` → RGBA composite.
2. Passes the result to `handle.prepareNewLayer(newId, name, merged)`.

In indexed8 mode, add a post-composite quantization step and call `prepareNewLayerIndexed` instead:

```ts
const { pixelFormat, swatches } = stateRef.current

// (after the existing await rasterizeLayers / rasterizeComposite call)
let pixelData: Uint8Array
if (pixelFormat === 'indexed8') {
  // Composite already returned RGBA from flushLayer-expanded textures.
  // Quantize back to palette indices.
  pixelData = await matchPaletteIndices(merged, swatches, 255)
} else {
  pixelData = merged
}

// (replace handle.prepareNewLayer with format-aware call)
if (pixelFormat === 'indexed8') {
  handle.prepareNewLayerIndexed(newId, mergedName, pixelData)
} else {
  handle.prepareNewLayer(newId, mergedName, pixelData)
}
```

This applies identically to all four merge operations. No changes to `rasterizeLayers` or
`rasterizeComposite` are needed — the GPU already returns RGBA (via `flushLayer` expansion) for
indexed8 layers.

`matchPaletteIndices` is imported from `src/wasm/index.ts`.

---

### Step 14 — Status bar pixel info

**File:** `src/core/store/cursorStore.ts`

Add the `pixelInfo` field and `setPixelInfo` method (see State Changes section above).

**File:** `src/ux/main/Canvas/Canvas.tsx`

In `buildCtx()`, add a `onIndexedHover` reference or wire it directly: after building the tool
context, add a side-channel that updates `cursorStore.pixelInfo` on every pointer move in
indexed8 mode. This runs in the `onPointerMove` handler (outside the tool handler dispatch):

```ts
// After forwarding the event to the tool handler:
if (state.pixelFormat === 'indexed8') {
  const cx = Math.floor(pos.x), cy = Math.floor(pos.y)
  // Sample topmost visible indexed layer at cursor
  for (let i = orderedLayers.length - 1; i >= 0; i--) {
    const gl = orderedLayers[i]
    if (!gl.visible || gl.format !== 'indexed8') continue
    const lx = cx - gl.offsetX, ly = cy - gl.offsetY
    if (lx < 0 || lx >= gl.layerWidth || ly < 0 || ly >= gl.layerHeight) continue
    const idx = (gl.data as Uint8Array)[ly * gl.layerWidth + lx]
    const p = idx < state.swatches.length ? state.swatches[idx] : { r: 0, g: 0, b: 0 }
    cursorStore.setPixelInfo({ index: idx, r: p.r, g: p.g, b: p.b })
    break
  }
}
```

Clear `cursorStore.setPixelInfo(null)` on `onLeave` and on pointer up when the cursor leaves canvas.

**File:** `src/ux/main/StatusBar/StatusBar.tsx`

Subscribe to `cursorStore` (already done via the existing `useEffect`). Add `pixelInfo` to the
cursor state:

```ts
const [cursor, setCursor] = useState<{ x: number; y: number; visible: boolean; pixelInfo: IndexedPixelInfo | null }>({
  x: cursorStore.x, y: cursorStore.y, visible: cursorStore.visible, pixelInfo: cursorStore.pixelInfo,
})
```

In the `cursor.visible` block:

```tsx
{cursor.visible && state.pixelFormat === 'indexed8' && cursor.pixelInfo !== null && (
  <>
    <span className={styles.sep} />
    <span className={styles.infoItem}>
      idx {cursor.pixelInfo.index}
      {cursor.pixelInfo.index < 255 && (
        <> · #{toHex(cursor.pixelInfo.r, cursor.pixelInfo.g, cursor.pixelInfo.b)}</>
      )}
    </span>
  </>
)}
```

`toHex` can be imported from `EmbedColorPicker.tsx` (already exported) or inlined as a one-liner.
Import `IndexedPixelInfo` from `cursorStore.ts`.

---

### Step 15 — Swatch management guards

**File:** `src/ux/main/RightPanel/Swatch/SwatchPanel.tsx`

Read `state.pixelFormat` from `useAppContext()`. Add the following guards wherever swatch mutations
are dispatched:

#### Block deletion of the last swatch in indexed8 mode

Before dispatching `REMOVE_SWATCH`, check:
```ts
if (state.pixelFormat === 'indexed8' && state.swatches.length <= 1) {
  showOperationError(
    'Cannot remove all swatches while in Indexed/8 mode.',
    'At least one palette entry is required.',
  )
  return
}
```

#### Warn before index-shifting deletion in indexed8 mode

Any swatch deletion in indexed8 mode shifts all higher indices. Show a confirmation before
dispatching `REMOVE_SWATCH`. Use the existing `ModalDialog` pattern:

```ts
if (state.pixelFormat === 'indexed8') {
  setPendingSwatchRemoval(canonicalIndex)   // new local state
  return
}
dispatch({ type: 'REMOVE_SWATCH', payload: canonicalIndex })
```

Mount a simple confirmation dialog when `pendingSwatchRemoval !== null`:
- Message: `"Removing this swatch will shift palette indices in all pixel layers. This operation can
  be undone."`
- Confirm button dispatches `REMOVE_SWATCH` then triggers the layer-pixel remap (see below).
- Cancel clears `pendingSwatchRemoval`.

#### Remap layer pixel data on swatch removal

When a swatch at `removedIndex` is deleted, all GPU layers with `format === 'indexed8'` must be
updated:
- Pixels with value `removedIndex` → set to 255 (void)
- Pixels with value `> removedIndex` and `< 255` → decremented by 1

This remap is a CPU-side pass. It can be invoked from `SwatchPanel` via a `onRemapLayersForSwatchRemoval(removedIndex)` callback provided from `App.tsx` / the parent panel, or it can be
driven from an effect in `Canvas.tsx` that watches `state.swatches.length`. The latter is simpler:

**File:** `src/ux/main/Canvas/Canvas.tsx` — add an effect:

```ts
const prevSwatchCountRef = useRef(state.swatches.length)

useEffect(() => {
  const prevLen = prevSwatchCountRef.current
  const newLen  = state.swatches.length
  prevSwatchCountRef.current = newLen

  if (state.pixelFormat !== 'indexed8' || newLen >= prevLen) return
  // A swatch was removed. Determine which index was removed by diffing the
  // palette (the reducer already removed it from AppState.swatches).
  // The removed index is passed via a new `lastRemovedSwatchIndex` field on AppState
  // (see below). Fall back to iterating all layers.
  const removedIndex = state.lastRemovedSwatchIndex
  if (removedIndex == null) return

  const renderer = rendererRef.current
  if (!renderer) return
  for (const gl of glLayersRef.current.values()) {
    if (gl.format !== 'indexed8') continue
    const data = gl.data as Uint8Array
    for (let i = 0; i < data.length; i++) {
      if (data[i] === removedIndex) {
        data[i] = 255
      } else if (data[i] > removedIndex && data[i] < 255) {
        data[i]--
      }
    }
    renderer.flushLayer(gl, state.swatches)
  }
  renderFromPlan()
}, [state.swatches])
```

This requires adding `lastRemovedSwatchIndex: number | null` to `AppState` and setting it in the
`REMOVE_SWATCH` reducer case. The field is reset to `null` after each removal by dispatching a
`CLEAR_REMOVED_SWATCH_INDEX` action, or it can be derived inline in the effect from the diff.
A simpler approach: the `REMOVE_SWATCH` reducer case itself sets `lastRemovedSwatchIndex` to the
payload index, and a `useEffect` in Canvas.tsx reacts to it.

#### Disable drag-reorder in indexed8 mode

In the `SwatchPanel` drag-and-drop implementation, conditionally disable the drag handle or the
`onDragStart` handler:

```ts
draggable={state.pixelFormat !== 'indexed8'}
onDragStart={state.pixelFormat !== 'indexed8' ? handleDragStart : undefined}
```

The handle element should receive `opacity: 0.3; pointer-events: none` when
`pixelFormat === 'indexed8'` via a conditional CSS class.

#### Block adding a 256th swatch in indexed8 mode

Before dispatching `ADD_SWATCH`, check:
```ts
if (state.pixelFormat === 'indexed8' && state.swatches.length >= 255) {
  showOperationError(
    'Indexed/8 mode supports a maximum of 255 palette entries.',
    'Index 255 is reserved as the transparent value.',
  )
  return
}
```

This guard applies wherever `ADD_SWATCH` is dispatched: `SwatchPanel`, `Toolbar.onAddSwatch`, and
any generate-palette dialog that calls `SET_SWATCHES` in bulk (cap the palette at 255 entries in
the bulk-set path by slicing the result to `slice(0, 255)` before dispatch).

---

## Architectural Constraints

- **All pixel writes go through `layer.data` → `flushLayer`**. The indexed8 drawing tools write
  directly to `layer.data` (1 byte per pixel), then call `renderer.flushLayer(layer, swatches)`.
  They never touch the GPU texture directly.

- **Tools branch on `ctx.layer.format`, not on `ctx.pixelFormat`**. The format is a property of
  the layer, not the context. This future-proofs the tool code against potential mixed-format
  scenarios and matches the `GpuLayer.format` field defined in the foundation.

- **Merge/flatten composites through the GPU pipeline unchanged**. The RGBA result from
  `rasterizeLayers` is correct because `flushLayer` already expanded indexed layers to RGBA before
  upload. Only the post-composite quantization step in `useLayers` is new.

- **Tool options UI reads `pixelFormat` from `useAppContext()`**, not from `ToolContext`. The
  options UI is a React component; it can access app state directly. Only the pointer-event handler
  path reads from `ToolContext`.

- **`IndexedPaletteColorPicker` is a widget** (`src/ux/widgets/`). It must not import `AppContext`
  directly. It receives `palette` and `activeIndex` as props from `Toolbar`, which reads them from
  `AppContext`.

- **No ad-hoc compositing paths**. The merge/flatten flow continues to use the existing
  `rasterizeLayers` / `rasterizeComposite` paths. Only the post-step quantization is new.

- **Crop and resize index data is encoded as `data:raw/indexed8;base64,...`** in `pendingLayerData`,
  consistent with the `.verve` v5 layer encoding defined in the foundation design. The Canvas init
  effect already handles this prefix (per the foundation design's load path).

---

## Open Questions

1. **`SET_ACTIVE_SWATCH` action**: The eyedropper design requires highlighting the sampled swatch in
   the Swatches panel. Does `AppState` already have an `activePaletteIndex` field, or does this
   need to be added? If the swatches panel uses its own local selection state, the eyedropper can
   instead emit a `focusSwatch(index)` notification via `swatchStore` (a new module-level store).
   Decision needed before Step 7.

2. **`lastRemovedSwatchIndex` in AppState**: The swatch-remap effect in Step 15 needs to know which
   index was removed. The cleanest implementation threads this through `AppState`. If a simpler
   approach is preferred (e.g. a module-level variable in `SwatchPanel`), that trades cleanliness
   for less state bloat. Decision needed before Step 15.

3. **Indexed8 pencil, size > 1, smoothing path**: The design describes stamping along a bezier
   using the EMA-smoothed coordinates. The step density (how many stamps per pixel of travel) must
   be confirmed to match the existing bezier-dab density to avoid gaps at the same size. The
   `walkQuadBezier` function's step count logic should be replicated in the indexed path.

4. **Export flow**: Export (PNG, JPEG, etc.) calls `rasterizeComposite('export')`, which returns
   RGBA from the GPU. For indexed8 documents the expanded RGBA is already correct. No changes to
   `useExportOps` should be needed — confirm this by tracing the export path end-to-end.

5. **`generatePalette` dialog (SET_SWATCHES)**: The spec requires capping the palette at 255 entries
   in indexed8 mode. Confirm that `SET_SWATCHES` in the reducer enforces this cap, or add the cap
   in the caller.
