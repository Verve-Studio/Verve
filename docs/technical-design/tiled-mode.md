# Technical Design: Tiled Mode

## Overview

Tiled Mode is a session-level view toggle that displays the composited canvas output nine times in a 3×3 grid. The center cell is the live editing canvas; the eight surrounding cells are real-time visual repeats of the same output buffer. Certain drawing tools wrap pixels that cross a canvas boundary back to the opposite edge so that edits tile seamlessly.

This feature touches four distinct concerns: (1) per-tab view state in the data model, (2) a new 2D-canvas display path in the Canvas component, (3) pan/zoom bookkeeping, and (4) optional coordinate wrapping in the pixel-write layer used by drawing tools and selection tools. Rendering correctness and per-stroke opacity capping are guaranteed by applying the wrap at the pixel-write level (`blendPixelOver`), not in the display path.

---

## Affected Areas

| File | Change |
|---|---|
| `src/types/index.ts` | Add `tiledMode` and `showTileGrid` to `CanvasState`; add `tiledMode` and `canvasWidth`/`canvasHeight` to `ToolContext` |
| `src/core/store/AppContext.tsx` | Add `SET_TILED_MODE` and `SET_SHOW_TILE_GRID` actions; extend `SWITCH_TAB` / `RESTORE_TAB` payloads; update `initialState` |
| `src/core/store/tabTypes.ts` | Add `tiledMode: boolean` and `showTileGrid: boolean` to `TabRecord` (not `TabSnapshot`) |
| `src/core/services/useTabs.ts` | Persist `tiledMode`/`showTileGrid` to the departing `TabRecord` before tab switch; restore from arriving `TabRecord` via `SWITCH_TAB` payload |
| `src/core/services/useCanvas.ts` | Add optional `tiledOffset?: { x: number; y: number }` option; subtract offset in `toCanvasPos`/`toRawPos`; relax bounds check in tiled mode |
| `src/ux/main/Canvas/Canvas.tsx` | Add `tiledCanvasRef`; update `doRender` to draw 9 tiles onto tiled canvas; show/hide canvases by mode; route pointer events to the correct canvas; adjust brush-cursor CSS offset; add tile-grid SVG overlay; pass `tiledMode`, `canvasWidth`, `canvasHeight` into `ToolContext` via `buildCtx()`; update `canvasWrapperRef` CSS dimensions |
| `src/ux/main/Canvas/canvasHandle.ts` | Add `tiledModeRef` injection so `fitToWindow()` uses `3W × 3H` virtual dimensions when tiled |
| `src/ux/main/TopBar/TopBar.tsx` | Add `onSetTiledMode`, `tiledMode`, `onToggleTileGrid`, `showTileGrid` props; extend View menu with Normal Mode, Tiled Mode, and Show Tile Grid items |
| `src/App.tsx` | Add `handleSetTiledMode` and `handleToggleTileGrid` callbacks; pass to `TopBar`; extend `macMenuHandlerRef` switch-case; sync macOS native menu checked state |
| `src/tools/types.ts` | Add `tiledMode: boolean` to `ToolContext` |
| `src/tools/algorithm/primitives.ts` | Add optional `tiledW?: number, tiledH?: number` to `blendPixelOver`; apply modular wrap before bounds check |
| `src/tools/algorithm/eraseStroke.ts` | Add optional `tiledW?: number, tiledH?: number` to `erasePixelOp` (the private pixel-op function); apply wrap before bounds check |
| `src/tools/algorithm/brushStroke.ts` | Thread `tiledW?/tiledH?` through `stampAirbrush` and `drawAirbrushCapsule` into `blendPixelOver` |
| `src/tools/algorithm/cloneStamp.ts` | Apply wrap to both destination pixels and source-sampling coordinates in `stampCloneSegment` |
| `src/tools/brush.tsx` | Pass `tiledW/tiledH` from `ctx.tiledMode` into stamp calls |
| `src/tools/eraser.tsx` | Same as brush |
| `src/tools/pencil.tsx` | Same as brush |
| `src/tools/pen.tsx` (if exists) | Same — pen rasterises via `drawLine`/`blendPixelOver` |
| `src/tools/cloneStamp.tsx` | Pass `tiledW/tiledH` to `stampCloneSegment`; wrap Alt-click source coordinates when setting sample point |
| `src/tools/select.tsx` | Apply wrap when writing to `selectionStore.mask` for out-of-bounds selection regions |
| `src/tools/lasso.tsx` | Same |
| `src/tools/polygonalSelection.tsx` | Same |
| `electron/main/ipc.ts` | Add `setTiledMode` and `toggleTileGrid` native-menu action IDs (macOS) |

---

## State Changes

### 1. `CanvasState` — `src/types/index.ts`

```ts
export interface CanvasState {
  // ... existing fields ...
  tiledMode: boolean       // default: false — not persisted to document
  showTileGrid: boolean    // default: false — session only, only meaningful when tiledMode is true
}
```

`tiledMode` and `showTileGrid` are **not** added to `TabSnapshot` and **not** captured by `captureActiveSnapshot()`. They are view-layer state, not document state.

### 2. `TabRecord` — `src/core/store/tabTypes.ts`

```ts
export interface TabRecord {
  // ... existing fields ...
  tiledMode: boolean    // preserved across tab switches within a session
  showTileGrid: boolean
}
```

Default value for both fields: `false`. Set explicitly when constructing new `TabRecord` objects (new tabs, file opens). Not serialised to the `.pxshop` file because `TabRecord` is in-memory only — the document format only reads/writes `TabSnapshot`.

### 3. New AppActions — `src/core/store/AppContext.tsx`

```ts
| { type: 'SET_TILED_MODE';    payload: boolean }
| { type: 'SET_SHOW_TILE_GRID'; payload: boolean }
```

Reducer logic:

```ts
case 'SET_TILED_MODE':
  return {
    ...state,
    canvas: {
      ...state.canvas,
      tiledMode: action.payload,
      // Always reset grid when leaving tiled mode
      showTileGrid: action.payload ? state.canvas.showTileGrid : false,
    },
  }

case 'SET_SHOW_TILE_GRID':
  return { ...state, canvas: { ...state.canvas, showTileGrid: action.payload } }
```

### 4. `SWITCH_TAB` / `RESTORE_TAB` payloads

Extend the existing `SWITCH_TAB` and `RESTORE_TAB` action payloads (in both `AppAction` and the reducer) to include:

```ts
tiledMode: boolean
showTileGrid: boolean
```

The reducer writes these into `state.canvas`. The `initialState` sets both to `false`.

### 5. `useTabs.ts` — saving and restoring per-tab tiled state

In `handleSwitchTab`, before `setTabs(updated)`, save the current tiled state to the departing tab's `TabRecord`:

```ts
const updated = tabs.map(t =>
  t.id === activeTabId
    ? { ...t, snapshot, savedHistory, savedLayerData,
        tiledMode: state.canvas.tiledMode,
        showTileGrid: state.canvas.showTileGrid }
    : t
)
```

In `switchToTab`, extend the `SWITCH_TAB` dispatch:

```ts
dispatch({
  type: 'SWITCH_TAB',
  payload: {
    // ...existing fields...
    tiledMode:    toTab.tiledMode    ?? false,
    showTileGrid: toTab.showTileGrid ?? false,
  },
})
```

> **Open Question (spec contradiction):** The Functional Requirements state "switching tabs must preserve the view mode of each tab independently," but the Acceptance Criteria state "opening or switching to a tab always starts in Normal Mode." The design above implements per-tab preservation (Functional Requirements), which is more useful and consistent with the rest of the spec. If the Acceptance Criteria intent wins, simply always pass `tiledMode: false, showTileGrid: false` in the `SWITCH_TAB` payload and remove the `tiledMode`/`showTileGrid` fields from `TabRecord`.

---

## Rendering Changes

### Architecture: 2D Canvas Overlay

The WebGPU renderer composites the scene into a W × H texture exactly as in Normal Mode — no changes to `WebGPURenderer` internals. In Tiled Mode, a **second `<canvas>` element** (the "tiled canvas") of `3W × 3H` CSS pixels is shown instead of the WebGPU canvas, and after every render frame the tiled canvas receives nine `drawImage` calls from the WebGPU canvas.

**Why this approach over resizing the WebGPU canvas to 3W × 3H:**
- Resizing the HTML canvas element invalidates the WebGPU context and requires a full remount of `WebGPURenderer`, which destroys all GPU textures and forces re-uploading every layer.
- The tiled canvas approach has zero cost at the compositing layer; only the display step changes.
- `drawImage(webgpuCanvas, ...)` on a `CanvasRenderingContext2D` is GPU-accelerated in Chromium (Electron's runtime) — it does not perform a CPU readback.
- The mirror-canvas pattern (used for the navigator thumbnail) already demonstrates this path works reliably.

### Canvas.tsx changes

#### New refs

```ts
const tiledCanvasRef = useRef<HTMLCanvasElement>(null)
const tiledModeRef   = useRef(state.canvas.tiledMode)
tiledModeRef.current = state.canvas.tiledMode
```

#### Updated `doRender()`

```ts
const doRender = (): void => {
  if (renderRafIdRef.current !== 0) return
  renderRafIdRef.current = requestAnimationFrame(() => {
    renderRafIdRef.current = 0
    const renderer = rendererRef.current
    if (!renderer) return
    renderer.renderPlan(buildRenderPlan())

    // Tiled display: copy GPU canvas to tiled 2D canvas nine times
    if (tiledModeRef.current) {
      const tc = tiledCanvasRef.current
      const gc = canvasRef.current
      if (tc && gc) {
        const ctx2d = tc.getContext('2d')
        if (ctx2d) {
          ctx2d.imageSmoothingEnabled = zoomRef.current < 1
          ctx2d.clearRect(0, 0, width * 3, height * 3)
          for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 3; col++) {
              ctx2d.drawImage(gc, col * width, row * height, width, height)
            }
          }
        }
      }
    }

    scheduleMirrorUpdate()
  })
}
```

#### Tiled canvas element (JSX)

Render the tiled canvas alongside the WebGPU canvas inside `canvasWrapperRef`. Show/hide based on `tiledMode`:

```tsx
<div
  ref={canvasWrapperRef}
  className={styles.canvasWrapper}
  style={{
    width:  (state.canvas.tiledMode ? width  * 3 : width)  * state.canvas.zoom / window.devicePixelRatio,
    height: (state.canvas.tiledMode ? height * 3 : height) * state.canvas.zoom / window.devicePixelRatio,
  }}
>
  {/* WebGPU canvas — visible in Normal Mode, hidden in Tiled Mode */}
  <canvas
    ref={canvasRef}
    style={{
      display: state.canvas.tiledMode ? 'none' : undefined,
      // ...existing style props (imageRendering, cursor, dimensions)...
    }}
    // ...event handlers only when NOT in tiled mode...
  />

  {/* Tiled display canvas — visible only in Tiled Mode */}
  {state.canvas.tiledMode && (
    <canvas
      ref={tiledCanvasRef}
      width={width * 3}
      height={height * 3}
      style={{
        width:  width  * 3 * state.canvas.zoom / window.devicePixelRatio,
        height: height * 3 * state.canvas.zoom / window.devicePixelRatio,
        imageRendering: state.canvas.zoom < 1 ? 'auto' : 'pixelated',
        cursor: /* same cursor logic as WebGPU canvas */,
      }}
      // Pointer events go here in tiled mode
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    />
  )}

  {/* Tile grid overlay — shown on top of the tiled canvas */}
  {state.canvas.tiledMode && state.canvas.showTileGrid && (
    <svg style={{
      position: 'absolute', top: 0, left: 0,
      width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: 3,
      overflow: 'visible',
    }}>
      {/* Vertical seam lines at 1/3 and 2/3 */}
      <line x1="33.333%" y1="0" x2="33.333%" y2="100%"
        stroke="rgba(255,255,255,0.5)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <line x1="66.667%" y1="0" x2="66.667%" y2="100%"
        stroke="rgba(255,255,255,0.5)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      {/* Horizontal seam lines */}
      <line x1="0" y1="33.333%" x2="100%" y2="33.333%"
        stroke="rgba(255,255,255,0.5)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <line x1="0" y1="66.667%" x2="100%" y2="66.667%"
        stroke="rgba(255,255,255,0.5)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </svg>
  )}

  {/* ...tool overlays, brushCursorRef divs, existing grid overlay (Normal Mode only)... */}
</div>
```

The existing WebGPU canvas pointer event handlers, tool overlay canvas, and brush cursor `<div>` remain unchanged in Normal Mode. In Tiled Mode, pointer events attach to the tiled canvas instead.

---

## Pan & Zoom Changes

### `canvasWrapperRef` size

As shown above, the wrapper CSS dimensions triple when `tiledMode` is active. The `viewport` div (scrollable container) does not change — it is always the full available workspace area. The scroll position shifts when entering/exiting tiled mode (see below).

### Entering Tiled Mode — scroll adjustment

When `tiledMode` is set to `true`, the center tile should appear at the same viewport position the single canvas occupied. The center tile starts at pixel offset `(W * zoom / dpr, H * zoom / dpr)` within the now-`3W × 3H` wrapper. Add a `useEffect` in `Canvas.tsx`:

```ts
useEffect(() => {
  if (!isActive) return
  const vp = viewportRef.current
  if (!vp) return
  if (state.canvas.tiledMode) {
    // Scroll the viewport to keep the center tile in the same screen position
    vp.scrollLeft += Math.round(width  * state.canvas.zoom / window.devicePixelRatio)
    vp.scrollTop  += Math.round(height * state.canvas.zoom / window.devicePixelRatio)
  } else {
    // Scroll back when leaving tiled mode (clamp to 0)
    vp.scrollLeft = Math.max(0, vp.scrollLeft - Math.round(width  * state.canvas.zoom / window.devicePixelRatio))
    vp.scrollTop  = Math.max(0, vp.scrollTop  - Math.round(height * state.canvas.zoom / window.devicePixelRatio))
  }
}, [state.canvas.tiledMode])  // eslint-disable-line react-hooks/exhaustive-deps
```

### Fit to Window — `canvasHandle.ts`

`fitToWindow()` (line 308 of `canvasHandle.ts`) currently uses `width` and `height` (the document dimensions) to compute the fit zoom. Inject a `tiledModeRef` into the handle so it can use `3 × width` and `3 × height` in Tiled Mode:

```ts
fitToWindow: () => {
  const vp = viewportRef.current
  if (!vp) return
  const dpr = window.devicePixelRatio || 1
  const scale = tiledModeRef.current ? 3 : 1
  const margin = 0.9
  const zoom = Math.min(
    (vp.clientWidth  / (width  * scale / dpr)) * margin,
    (vp.clientHeight / (height * scale / dpr)) * margin,
  )
  onZoom(parseFloat(Math.max(0.05, Math.min(32, zoom)).toFixed(4)))
},
```

`tiledModeRef` is passed into `useCanvasHandle` from `Canvas.tsx`:
```ts
useCanvasHandle({
  // ...existing args...
  tiledModeRef,
})
```

---

## Tool Wrap-Around

### Pointer coordinate system in Tiled Mode

The tiled canvas is `3W × 3H` device pixels. `useCanvas.ts`'s `toCanvasPos` / `toRawPos` compute pixel-space coordinates from pointer client coordinates. In Tiled Mode the element is three times larger but the scale factor `scaleX = canvas.width / rect.width` is the same (`dpr / zoom`). The resulting pixel `(px, py)` is in [0, 3W−1] × [0, 3H−1].

To give tools raw canvas-space coordinates (center tile = [0, W−1] × [0, H−1]):

Add `tiledOffset?: { x: number; y: number }` to `UseCanvasOptions`:

```ts
interface UseCanvasOptions {
  // ...existing fields...
  tiledOffset?: { x: number; y: number } // in canvas device pixels
}
```

In `toCanvasPos` and `toRawPos`, subtract the offset:

```ts
const x = Math.floor((e.clientX - rect.left) * scaleX) - (tiledOffset?.x ?? 0)
const y = Math.floor((e.clientY - rect.top)  * scaleY) - (tiledOffset?.y ?? 0)
```

The existing bounds check `if (x < 0 || y < 0 || x >= e.currentTarget.width || y >= e.currentTarget.height) return null` fires against the **untransformed** pixel before the offset is subtracted — or should be removed and only applied in `toCanvasPos` (not `toRawPos`, which is already bounds-unchecked). After the offset subtraction, `x` may be negative (pointing at a left/top tile) or ≥ W (pointing at a right/bottom tile). This is intentional. Tools decide how to handle out-of-range coordinates.

Canvas.tsx passes `tiledOffset` when calling `useCanvas`:

```ts
const { handlePointerDown, ... } = useCanvas({
  // ...existing callbacks...
  tiledOffset: state.canvas.tiledMode
    ? { x: width, y: height }
    : undefined,
})
```

### Brush cursor position in Tiled Mode

The brush cursor `<div>` is positioned inside `canvasWrapperRef`. In Normal Mode the position is `pos.x * zoom / dpr`. In Tiled Mode, `pos.x` is the raw canvas coordinate (could be negative), so the CSS offset must add `W * zoom / dpr`:

```ts
const tileOffsetCss = state.canvas.tiledMode
  ? width  * state.canvas.zoom / window.devicePixelRatio
  : 0
const cx = pos.x * zoom / dpr + tileOffsetCss
const cy = pos.y * zoom / dpr + (state.canvas.tiledMode ? height * zoom / dpr : 0)
```

### `ToolContext` extension — `src/tools/types.ts`

```ts
export interface ToolContext {
  // ...existing fields...
  tiledMode: boolean
}
```

`tiledMode` is read by wrap-capable tool handlers. The document dimensions for the wrap formula are always `ctx.renderer.pixelWidth` and `ctx.renderer.pixelHeight` (they never change in Tiled Mode since the WebGPU renderer is not remounted).

`Canvas.tsx`'s `buildCtx()` adds:

```ts
tiledMode: state.canvas.tiledMode,
```

### Recommended wrap-around approach: Option B — shared pixel-write utility

**Decision: Apply the wrap in `blendPixelOver` (Option B, `primitives.ts`), not in each tool handler (Option A) and not in `flushLayer` (Option C).**

**Justification:**

- **Option A (per-tool):** the same bounding/coverage loops exist in `stampAirbrush`, `drawAirbrushCapsule`, `eraseStampCircle`, `stampCloneSegment`, and the pen rasterizer. Duplicating the wrap formula in each is error-prone and easily missed when adding future tools.
- **Option C (`flushLayer`):** too late — `flushLayer` uploads `layer.data` to the GPU texture. Writing a pixel at `(-1, 0)` and a pixel at `(W-1, 0)` in the same stroke must share a single entry in the `touched` coverage map (they are the same physical pixel). If the wrap is applied after `blendPixelOver`'s coverage-map lookup, the two writes get separate entries and the second is treated as additive, violating the per-stroke opacity cap.
- **Option B:** the wrap is applied BEFORE the `touched` map key is computed (`key = canvasY * renderer.pixelWidth + canvasX`). Both `(-1, 0)` and `(W-1, 0)` resolve to the same key `(W-1)` before the map lookup, so the cap is correctly enforced. One change to one function handles all current and future pixel-writing tools that go through `blendPixelOver`.

### `blendPixelOver` — `src/tools/algorithm/primitives.ts`

Add two optional trailing parameters:

```ts
export function blendPixelOver(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  canvasX: number,
  canvasY: number,
  r: number, g: number, b: number, a: number,
  opacity: number,
  touched?: Map<number, number>,
  sel?: SelMask,
  tiledW?: number,
  tiledH?: number,
): void {
  // Apply modular wrap BEFORE bounds check and touched-map key computation
  if (tiledW !== undefined && tiledH !== undefined) {
    canvasX = ((canvasX % tiledW) + tiledW) % tiledW
    canvasY = ((canvasY % tiledH) + tiledH) % tiledH
  }
  // ... rest of existing implementation unchanged ...
}
```

Because `tiledW` and `tiledH` are optional and last in the parameter list, all existing call sites continue to compile without change.

### `erasePixelOp` — `src/tools/algorithm/eraseStroke.ts`

Apply the same pattern: add optional `tiledW?: number, tiledH?: number` to `erasePixelOp` and wrap before the bounds check and `touched` lookup.

### `stampAirbrush` / `drawAirbrushCapsule` — `src/tools/algorithm/brushStroke.ts`

Both functions call `blendPixelOver`. Add `tiledW?: number, tiledH?: number` to their signatures and thread through to `blendPixelOver`.

### `stampCloneSegment` — `src/tools/algorithm/cloneStamp.ts`

Clone stamp has two independent wrapping requirements:

1. **Destination pixels:** the painted pixel `(px, py)` may exit the canvas boundary. Apply wrap to `(px, py)` before calling `blendPixelOver`. Since `blendPixelOver` now handles the wrap internally (Option B), passing `tiledW/tiledH` covers this automatically.

2. **Source sampling:** the source point `(srcX, srcY) = (px + offsetDX, py + offsetDY)` may also land outside the canvas. The source is sampled from a canvas-sized buffer `sourceBuffer`. Apply the wrap to `(srcX, srcY)` before the buffer lookup:

```ts
// In stampCloneSegment, after computing srcX/srcY:
if (tiledW !== undefined && tiledH !== undefined && sourceIsCanvas) {
  srcX = ((Math.round(srcX) % tiledW) + tiledW) % tiledW
  srcY = ((Math.round(srcY) % tiledH) + tiledH) % tiledH
}
```

Add `tiledW?: number, tiledH?: number` to `stampCloneSegment`'s parameter list and pass them from `cloneStamp.tsx`.

**Clone stamp Alt-click source in Tiled Mode:**

When the user Alt-clicks on a surrounding tile to set the source point, `cloneStamp.tsx`'s `onPointerDown` receives raw canvas coordinates (possibly outside [0, W-1]). Wrap them before storing in `cloneStampStore`:

```ts
// In cloneStamp.tsx onPointerDown, when altKey is true:
const sourceX = ctx.tiledMode
  ? ((pos.x % ctx.renderer.pixelWidth)  + ctx.renderer.pixelWidth)  % ctx.renderer.pixelWidth
  : pos.x
const sourceY = ctx.tiledMode
  ? ((pos.y % ctx.renderer.pixelHeight) + ctx.renderer.pixelHeight) % ctx.renderer.pixelHeight
  : pos.y
cloneStampStore.setSource(sourceX, sourceY, ...)
```

### Selection tools — rectangular, lasso, polygonal

Selection masks are `canvasWidth × canvasHeight` byte arrays stored in `selectionStore`. When a tool writes a selection that extends outside the canvas boundary in Tiled Mode, the out-of-bounds pixels must be wrapped back into the canvas.

The three affected tools (`select.tsx`, `lasso.tsx`, `polygonalSelection.tsx`) write selection masks by calling methods on `selectionStore` (e.g. `setRect`, `floodFillSelect`, writing to `selectionStore.mask` directly via `selectionStore.setPixel`). For Tiled Mode:

- **Rectangular selection (`select.tsx`):** after computing the drag rect `(x1, y1, x2, y2)`, if `tiledMode` is active and the rect extends outside canvas bounds, split it into up to four sub-rects (one per overlapping quadrant after wrapping) and apply each sub-rect as a union to the mask. Implement a helper `applyWrappedSelectionRect(x1, y1, x2, y2, W, H, mask, mode)` near `select.tsx` or inside a shared selection utility.
- **Lasso / Polygonal selection:** wrap coordinates pixel-by-pixel when writing the scanline fill to the selection mask. The polygon/scanline computation can produce pixel coordinates outside [0, W-1]; wrap each before writing to `mask[y * W + x]`.

> **Implementation note:** if `selectionStore` exposes a `setPixel(x, y, value)` method, add an optional `tiledMode` flag to it that applies the wrap formula internally. Otherwise wrap at the call sites in the tool handlers.

### Tools NOT in scope (no changes needed)

The following tools already call `blendPixelOver` (or `drawCanvasPixel`/`sampleCanvasPixel`) with canvas-space coordinates and rely on the existing out-of-bounds rejection: `fill.tsx`, `gradient.tsx`, `move.tsx`, `transform.tsx`, `shape.tsx`, `text.tsx`, `zoom.tsx`, `eyedropper.tsx`, `magicWand.tsx`, `objectSelection.tsx`. These tools do NOT receive `tiledW/tiledH` and so wrap-around is never applied for them — out-of-bounds pixels are silently discarded by the existing guard in `blendPixelOver`.

For these tools, `ctx.tiledMode` is available but unused. If the user clicks on a surrounding tile while one of these tools is active, `toCanvasPos` returns a coordinate outside [0, W-1]; the tool handler either ignores it or `blendPixelOver` discards the pixel write. Either way, no effect. No additional changes are needed.

---

## View Menu Changes

### `TopBar.tsx` — new View menu items

Current View menu:
```
Zoom In          Ctrl+=
Zoom Out         Ctrl+-
Fit to Window    Ctrl+0
─────────────────
Show Grid        Ctrl+G
```

New View menu:
```
Zoom In          Ctrl+=
Zoom Out         Ctrl+-
Fit to Window    Ctrl+0
─────────────────
Normal Mode      (checkmark when tiledMode = false)
Tiled Mode       (checkmark when tiledMode = true)
─────────────────
Show Tile Grid   (disabled when tiledMode = false; checkmark when showTileGrid = true)
─────────────────
Show Grid        Ctrl+G
Show Rulers
```

### New `TopBar` props

```ts
onSetNormalMode: () => void
onSetTiledMode:  () => void
tiledMode:       boolean
onToggleTileGrid: () => void
showTileGrid:    boolean
```

Menu item definitions (inside the `useMemo` menu array in `TopBar.tsx`):

```ts
{ separator: true, label: '' },
{ label: 'Normal Mode', action: onSetNormalMode, checked: !tiledMode },
{ label: 'Tiled Mode',  action: onSetTiledMode,  checked: tiledMode },
{ separator: true, label: '' },
{ label: 'Show Tile Grid', action: onToggleTileGrid, checked: showTileGrid, disabled: !tiledMode },
{ separator: true, label: '' },
```

### `App.tsx` — new callbacks

```ts
const handleSetNormalMode = useCallback(() => {
  dispatch({ type: 'SET_TILED_MODE', payload: false })
}, [dispatch])

const handleSetTiledMode = useCallback(() => {
  dispatch({ type: 'SET_TILED_MODE', payload: true })
}, [dispatch])

const handleToggleTileGrid = useCallback(() => {
  dispatch({ type: 'SET_SHOW_TILE_GRID', payload: !stateRef.current.canvas.showTileGrid })
}, [dispatch])
```

Pass all three to `TopBar`. Add `'setNormalMode'`, `'setTiledMode'`, and `'toggleTileGrid'` cases to the `macMenuHandlerRef` switch.

### macOS native menu — `electron/main/ipc.ts`

Add the three new menu items to `buildNativeMenu` with their action IDs. Sync checked state:

```ts
// In the effect that calls window.api.setMenuItemChecked:
window.api.setMenuItemChecked({
  toggleGrid:      state.canvas.showGrid,
  setNormalMode:   !state.canvas.tiledMode,
  setTiledMode:    state.canvas.tiledMode,
  toggleTileGrid:  state.canvas.showTileGrid,
})
```

---

## Implementation Steps

1. **`src/types/index.ts`** — Add `tiledMode: boolean` and `showTileGrid: boolean` to `CanvasState`. Add `tiledMode: boolean` to `ToolContext` (in `src/tools/types.ts`).

2. **`src/core/store/AppContext.tsx`** — Add `SET_TILED_MODE` and `SET_SHOW_TILE_GRID` to `AppAction`. Add reducer cases. Update `initialState.canvas` (both `false`). Extend `SWITCH_TAB` and `RESTORE_TAB` payloads to include `tiledMode` and `showTileGrid`; set both to `false` in the reducer when these payloads arrive (restoring from per-tab storage via `useTabs`).

3. **`src/core/store/tabTypes.ts`** — Add `tiledMode: boolean` and `showTileGrid: boolean` to `TabRecord` with default `false`. Update the initial `TabRecord` creation in `useTabs.ts`.

4. **`src/core/services/useTabs.ts`** — In `handleSwitchTab`, save current `state.canvas.tiledMode`/`showTileGrid` to the departing tab's `TabRecord`. In `switchToTab`, read from `toTab.tiledMode`/`showTileGrid` and include in `SWITCH_TAB` payload.

5. **`src/tools/algorithm/primitives.ts`** — Add `tiledW?/tiledH?` to `blendPixelOver`. Add wrap formula before bounds check.

6. **`src/tools/algorithm/eraseStroke.ts`** — Same change to `erasePixelOp`.

7. **`src/tools/algorithm/brushStroke.ts`** — Thread `tiledW?/tiledH?` through `stampAirbrush` and `drawAirbrushCapsule` into `blendPixelOver`.

8. **`src/tools/algorithm/cloneStamp.ts`** — Thread `tiledW?/tiledH?` into `stampCloneSegment`; wrap source-sample coordinates; wrap destination coords (already handled by `blendPixelOver` if parameters are threaded through).

9. **`src/tools/brush.tsx`, `eraser.tsx`, `pencil.tsx`** — Pass `tiledW = ctx.tiledMode ? ctx.renderer.pixelWidth : undefined` (and `tiledH`) to stamp/capsule calls.

10. **`src/tools/cloneStamp.tsx`** — Pass `tiledW/tiledH` to `stampCloneSegment`; apply wrap to Alt-click source coordinates before storing.

11. **`src/tools/select.tsx`, `lasso.tsx`, `polygonalSelection.tsx`** — Implement wrapped selection mask writing for out-of-bounds regions in Tiled Mode (see Selection tools section above).

12. **`src/core/services/useCanvas.ts`** — Add `tiledOffset?` option; subtract offset in `toCanvasPos`/`toRawPos`.

13. **`src/ux/main/Canvas/canvasHandle.ts`** — Accept and store `tiledModeRef`; use in `fitToWindow()`.

14. **`src/ux/main/Canvas/Canvas.tsx`** — Add `tiledCanvasRef`, `tiledModeRef`; update `doRender()` for tiled drawing; update JSX to render/hide the two canvases; route pointer events; add tile-grid SVG overlay; fix brush-cursor CSS offset in tiled mode; pass `tiledMode` into `buildCtx()`; pass `tiledOffset` to `useCanvas`; add `useEffect` for scroll adjustment on mode change; pass `tiledModeRef` to `useCanvasHandle`.

15. **`src/App.tsx`** — Add `handleSetNormalMode`, `handleSetTiledMode`, `handleToggleTileGrid`; pass to `TopBar`; extend `macMenuHandlerRef` and native-menu sync effects.

16. **`src/ux/main/TopBar/TopBar.tsx`** — Add new props; add three View menu items (Normal Mode, Tiled Mode, Show Tile Grid).

17. **`electron/main/ipc.ts`** — Extend `buildNativeMenu` and checked-state sync for the three new macOS menu items.

---

## Architectural Constraints

From `AGENTS.md`:

- **Module-level singletons for tools** — Drawing options (`brushOptions`, `eraserOptions`, etc.) are already module-level. `tiledW`/`tiledH` are derived from `ctx.renderer.pixelWidth` at stroke time, not from module-level state, so this pattern is not violated.
- **No UI state for pointer performance** — The brush cursor positioning change (step 14) remains imperative (setting `el.style.left` directly), consistent with the existing cursor implementation.
- **Per-tab state pattern** — `tiledMode` follows the exact same lifecycle as `zoom`: stored in `CanvasState` for rendering, saved to `TabRecord` on tab switch, NOT written into `TabSnapshot` (so not persisted to the document file).
- **No separate compositing paths** — The compositing pipeline (`encodePlanToComposite`) is unmodified. The spec requirement "the rendering pipeline runs once; the single result is blitted nine times" is satisfied by the 9 `drawImage` calls after `renderer.renderPlan()`.
- **Unified rasterization pipeline** — Flatten, merge, and export use `rasterizeDocument` which calls `readFlattenedPlan` on the WebGPU renderer. Neither `tiledMode` nor `showTileGrid` are passed into this path; it always renders a single W × H output. No changes needed to the rasterization pipeline.
- **`blendPixelOver` correctness** — The touched-map key `canvasY * renderer.pixelWidth + canvasX` is computed AFTER the wrap. This correctly ensures the per-stroke opacity cap applies to the physical pixel (same pixel visited via direct path and via wrapped path counts as one visit).

---

## Open Questions / Risks

1. **Spec contradiction — tab switch behavior.** The Functional Requirements say switching tabs preserves per-tab view mode; the Acceptance Criteria say switching always starts in Normal Mode. The design implements per-tab preservation. Confirm with product before implementing step 4.

2. **`growLayerToFit` in Tiled Mode.** The canvas handle calls `renderer.growLayerToFit(canvasX, canvasY, extraRadius)` before writing pixels. `growLayerToFit` rejects coordinates outside canvas bounds. In Tiled Mode, tool handlers MUST apply the wrap to `pos.x/pos.y` BEFORE calling `ctx.growLayerToFit(...)`, not after. This is the caller's responsibility; the design assumes tool handlers follow the wrap-first, grow-second order. If a tool calls `growLayerToFit` with a raw pre-wrap coordinate (e.g., -5), `growLayerToFit` will silently return `false` and the subsequent pixel write will succeed (write to the wrapped coord). This is safe but wastes a `growLayerToFit` call; developers should document the order.

3. **`drawImage` performance on very large canvases.** Nine `drawImage(gpuCanvas, col*W, row*H, W, H)` calls per frame copy `9 × W × H` pixels on the GPU-compositor path. For a 4K canvas (3840 × 2160), this is 9 × ~32MB ≈ 288MB of pixel data per frame, which may exceed 60 fps on integrated graphics. The compositing is GPU-accelerated, but profiling should be done at target canvas sizes before shipping. Mitigation: limit the tiled canvas update to the same RAF coalescing already applied to the mirror canvas update.

4. **`drawImage` from WebGPU canvas in Electron.** The existing mirror-canvas path (`scheduleMirrorUpdate`) already does `createImageBitmap(gpuCanvas)` + `drawImage` — this confirms the API works in the Electron version used. The synchronous `drawImage(gpuCanvas, ...)` path (without `createImageBitmap`) should also work, but should be verified in the actual Electron version since the spec for direct WebGPU→2D-canvas `drawImage` has had implementation gaps in older Chromium versions.

5. **Pen tool wrap-around.** The pen (Bézier) tool rasterises a completed curve into pixels. The design assumes it calls `blendPixelOver` or `drawLine` for individual pixels; if it uses a different write path (e.g. writing directly to `layer.data` via `renderer.drawCanvasPixel`), that path will NOT apply the wrap. Verify the pen tool's pixel-write path before step 9.

6. **Selection wrap with complex shapes.** Lasso and polygonal selection tools produce arbitrary polygon interiors. Implementing correct toroidal wrap (handling all four edge-crossing cases including diagonal corners) for scanline-filled polygons is non-trivial. Consider deferring lasso/polygonal selection wrap to v1.1 and noting the limitation in the UI.

7. **Marching ants overlay in Tiled Mode.** The marching ants overlay (`overlayRef`) and the `useMarchingAnts` hook draw the selection marquee at canvas-space coordinates. In Tiled Mode, the marquee should repeat across all nine tiles. This is out of scope in the current design; `useMarchingAnts` would need updates to draw the selection at each tile offset. For v1, the marching ants will only appear on the center tile.

8. **Tool overlay canvas (`toolOverlayRef`) in Tiled Mode.** The transform overlay, clone stamp overlay, and object selection overlay are drawn on `toolOverlayRef` at canvas-space coordinates. In Tiled Mode, they will only appear on the center tile (since the overlay canvas is still W × H). For v1, this is acceptable.
