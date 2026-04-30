# Technical Design: Pixelate Filter

## Overview

Pixelate is a destructive filter that divides the active pixel layer into a uniform grid of square blocks and replaces every pixel in each block with the arithmetic mean RGBA of that block's source pixels. It follows the same pattern as every other filter in Verve: a WebGPU compute shader executes the pixel operation, a modal dialog hosts the controls and debounced preview, and the result is committed to the layer via a single `captureHistory` call. The dialog is wider than simpler filter dialogs (452 px) because the UX design specifies a two-column layout with a 220 × 165 px embedded preview panel on the left.

---

## Implementation Decision: WebGPU Compute Shader vs WASM

**Decision: WebGPU compute shader.**

All 14 existing filters use the `FilterComputeEngine` in `src/webgpu/filterCompute.ts`. Adding a WASM path for pixelate would require bypassing that engine entirely, introduce a second execution model for filters, and leave the filter outside the unified pipeline. WebGPU is the correct fit architecturally.

The pixelate algorithm (block average) maps cleanly to a compute shader. The one non-trivial concern is preventing O(W × H × S²) total work as block size grows: the naive "one thread per output pixel, sample the whole block" approach becomes untenable at S = 300 on a 1920 × 1080 image (~583 billion source reads). The solution is a **per-block dispatch**: each compute invocation handles exactly one block (reads ≤ S² source pixels, writes ≤ S² output pixels). Total reads and writes are always O(W × H) regardless of S. Dispatch count is computed dynamically at encode time from the block count.

---

## Affected Areas

| File | Status | Change |
|---|---|---|
| `src/webgpu/shaders/filters/pixelate.ts` | **Create** | WGSL shader string + `runPixelate()` |
| `src/webgpu/filterCompute.ts` | Modify | Add `pixelatePipeline`, engine method, singleton export |
| `src/filters/registry.ts` | Modify | Extend `group` union with `'pixelate'`; add registry entry |
| `src/types/index.ts` | Modify | Add `'pixelate'` to `FilterKey` |
| `src/hooks/useFilters.ts` | Modify | Add `handleOpenPixelate` to return type + implementation |
| `src/components/dialogs/PixelateDialog/PixelateDialog.tsx` | **Create** | Dialog component |
| `src/components/dialogs/PixelateDialog/PixelateDialog.module.scss` | **Create** | Dialog styles |
| `src/components/index.ts` | Modify | Barrel-export `PixelateDialog` |
| `src/App.tsx` | Modify | `showPixelateDialog` state, switch case, import, JSX |

---

## State Changes

No new fields are added to `AppState`. No new reducer actions are needed. All dialog state is local to `PixelateDialog`.

---

## New Components / Hooks / Tools

### `PixelateDialog` (dialog)

**Single responsibility:** Present the Pixel Size and Snap to Grid controls, run debounced GPU previews against the original pixel snapshot, and commit or discard the result.

**Props** (identical shape to all other filter dialogs):
```ts
interface PixelateDialogProps {
  isOpen:          boolean
  onClose:         () => void
  canvasHandleRef: { readonly current: CanvasHandle | null }
  activeLayerId:   string | null
  captureHistory:  (label: string) => void
  canvasWidth:     number
  canvasHeight:    number
}
```

**Local state:**
- `pixelSize: number` — current pixel size; always within `[2, maxBlockSize]`
- `snapToGrid: boolean` — whether snap constraint is active; default `false`
- `isBusy: boolean` — GPU preview in flight
- `hasSelection: boolean` — read from `selectionStore` once on open
- `errorMessage: string | null`

**Refs (persistent across renders, not causing re-renders):**
- `originalPixelsRef` — snapshot of layer pixels taken when the dialog opens
- `selectionMaskRef` — snapshot of `selectionStore.mask` taken when the dialog opens
- `isBusyRef` — synchronous mirror of `isBusy` used inside async callbacks
- `debounceTimerRef` — timeout handle for preview debounce
- `maxBlockSizeRef` — `Math.floor(Math.min(canvasWidth, canvasHeight) / 2)`, computed once on open
- `snapDivisorsRef` — sorted array of common divisors of W and H that are ≥ 2, computed once on open

### `runPixelate` (shader function in `src/webgpu/shaders/filters/pixelate.ts`)

**Single responsibility:** Encode and submit one compute pass that pixelates a flat `Uint8Array` and returns the result as a new `Uint8Array`.

---

## Implementation Steps

### Step 1 — Add `'pixelate'` to `FilterKey` (`src/types/index.ts`)

Append `| 'pixelate'` to the `FilterKey` union.

---

### Step 2 — Update `FilterRegistryEntry` and add entry (`src/filters/registry.ts`)

Extend the `group` union literal type to include `'pixelate'`:

```ts
group?: 'blur' | 'sharpen' | 'noise' | 'render' | 'pixelate'
```

Append to `FILTER_REGISTRY`:

```ts
{ key: 'pixelate', label: 'Pixelate…', group: 'pixelate' },
```

---

### Step 3 — Write the WGSL shader (`src/webgpu/shaders/filters/pixelate.ts`)

```ts
import { createUniformBuffer, writeUniformBuffer, createReadbackBuffer, unpackRows } from '../../utils'

export const FILTER_PIXELATE_COMPUTE = /* wgsl */ `
struct PixelateParams {
  blockSize : u32,
  width     : u32,
  height    : u32,
  _pad      : u32,
}

@group(0) @binding(0) var srcTex        : texture_2d<f32>;
@group(0) @binding(1) var dstTex        : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params : PixelateParams;

// Each invocation handles one block (column blockX = id.x, row blockY = id.y).
// Dispatch count: (ceil(ceil(W/S) / 8), ceil(ceil(H/S) / 8), 1).
@compute @workgroup_size(8, 8)
fn cs_pixelate(@builtin(global_invocation_id) id: vec3u) {
  let S  = params.blockSize;
  let w  = params.width;
  let h  = params.height;

  // Block origin in image space
  let bx = id.x * S;
  let by = id.y * S;
  if (bx >= w || by >= h) { return; }

  // Inclusive extent, clamped for partial edge blocks
  let ex = min(bx + S, w);
  let ey = min(by + S, h);

  var sum   = vec4f(0.0);
  var count = 0u;

  for (var py = by; py < ey; py++) {
    for (var px = bx; px < ex; px++) {
      sum   += textureLoad(srcTex, vec2u(px, py), 0);
      count += 1u;
    }
  }

  let avg = sum / f32(count);

  for (var py = by; py < ey; py++) {
    for (var px = bx; px < ex; px++) {
      textureStore(dstTex, vec2u(px, py), avg);
    }
  }
}
` as const

export async function runPixelate(
  device:   GPUDevice,
  pipeline: GPUComputePipeline,
  pixels:   Uint8Array,
  w:        number,
  h:        number,
  blockSize: number,
): Promise<Uint8Array> {
  const srcTex = device.createTexture({
    size:   { width: w, height: h },
    format: 'rgba8unorm',
    usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  device.queue.writeTexture(
    { texture: srcTex },
    pixels as Uint8Array<ArrayBuffer>,
    { bytesPerRow: w * 4, rowsPerImage: h },
    { width: w, height: h },
  )

  const outTex = device.createTexture({
    size:   { width: w, height: h },
    format: 'rgba8unorm',
    usage:  GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  })

  const paramsData = new Uint32Array([blockSize, w, h, 0])
  const paramsBuf  = createUniformBuffer(device, 16)
  writeUniformBuffer(device, paramsBuf, paramsData)

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: outTex.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
    ],
  })

  const blockCountX = Math.ceil(w / blockSize)
  const blockCountY = Math.ceil(h / blockSize)

  const encoder = device.createCommandEncoder()
  const pass    = encoder.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.dispatchWorkgroups(Math.ceil(blockCountX / 8), Math.ceil(blockCountY / 8))
  pass.end()

  const alignedBpr = Math.ceil(w * 4 / 256) * 256
  const readbuf    = createReadbackBuffer(device, alignedBpr * h)
  encoder.copyTextureToBuffer(
    { texture: outTex },
    { buffer: readbuf, bytesPerRow: alignedBpr, rowsPerImage: h },
    { width: w, height: h },
  )

  device.queue.submit([encoder.finish()])

  await readbuf.mapAsync(GPUMapMode.READ)
  const result = unpackRows(new Uint8Array(readbuf.getMappedRange()), w, h, alignedBpr)
  readbuf.unmap()

  srcTex.destroy()
  outTex.destroy()
  paramsBuf.destroy()
  readbuf.destroy()

  return result
}
```

Key points:
- `workgroup_size(8, 8)` matches the convention used by all other shaders.
- Dispatch is based on **block count**, not pixel count, so each invocation covers exactly one block.
- Integer division `id.x * S` gives the block origin directly from the invocation index.
- Edge blocks where `bx + S > w` or `by + S > h` are handled by clamping to `min(bx+S, w)` / `min(by+S, h)`.
- No intermediate texture is needed — unlike Gaussian blur, pixelate is not separable and does not require a two-pass approach.

---

### Step 4 — Register the pipeline in `FilterComputeEngine` (`src/webgpu/filterCompute.ts`)

**4a.** Add import at the top:
```ts
import { FILTER_PIXELATE_COMPUTE, runPixelate } from './shaders/filters/pixelate'
```

**4b.** Add field to the class:
```ts
private readonly pixelatePipeline: GPUComputePipeline
```

**4c.** Initialize in the constructor (after existing pipeline assignments):
```ts
this.pixelatePipeline = this.makePipeline(FILTER_PIXELATE_COMPUTE, 'cs_pixelate')
```

**4d.** Add engine method:
```ts
async pixelate(pixels: Uint8Array, width: number, height: number, blockSize: number): Promise<Uint8Array> {
  return runPixelate(this.device, this.pixelatePipeline, pixels, width, height, blockSize)
}
```

**4e.** Add singleton export function at the bottom:
```ts
export async function pixelate(pixels: Uint8Array, width: number, height: number, blockSize: number): Promise<Uint8Array> {
  return _engine!.pixelate(pixels, width, height, blockSize)
}
```

---

### Step 5 — Add `handleOpenPixelate` to `useFilters` (`src/hooks/useFilters.ts`)

**5a.** Add to `UseFiltersReturn`:
```ts
handleOpenPixelate: () => void
```

**5b.** Add implementation inside the hook body (alongside the other `handleOpen*` callbacks):
```ts
const handleOpenPixelate = useCallback(
  () => onOpenFilterDialog('pixelate'),
  [onOpenFilterDialog]
)
```

**5c.** Include in the returned object:
```ts
return {
  // …existing entries…
  handleOpenPixelate,
}
```

---

### Step 6 — Create `PixelateDialog` (`src/components/dialogs/PixelateDialog/PixelateDialog.tsx`)

The component follows the established pattern from `GaussianBlurDialog` with two additions: computed max block size and snap-to-grid logic.

**Module-level helpers** (not in a separate utility file — single use):

```ts
// Euclidean GCD
function gcd(a: number, b: number): number {
  while (b !== 0) { [a, b] = [b, a % b] }
  return a
}

// Returns all common divisors of w and h that are >= 2, sorted ascending.
// Common divisors = divisors of GCD(w, h).
function computeCommonDivisors(w: number, h: number): number[] {
  const g = gcd(w, h)
  const divisors: number[] = []
  for (let i = 2; i <= g; i++) {
    if (g % i === 0) divisors.push(i)
  }
  return divisors
}

// Returns the value in `sorted` (ascending) closest to `target`.
// On equal distance, prefers the smaller value.
function nearestDivisor(sorted: number[], target: number): number {
  let best = sorted[0]
  let bestDist = Math.abs(sorted[0] - target)
  for (const d of sorted) {
    const dist = Math.abs(d - target)
    if (dist < bestDist) { best = d; bestDist = dist }
  }
  return best
}
```

**Constants:**
```ts
const MIN_BLOCK_SIZE     = 2
const DEFAULT_BLOCK_SIZE = 10
const DEBOUNCE_MS        = 25
```

**Key behaviors to implement:**

- **On open:** snapshot `originalPixels`, snapshot `selectionMask`, compute `maxBlockSize = Math.floor(Math.min(canvasWidth, canvasHeight) / 2)`, compute `snapDivisors = computeCommonDivisors(canvasWidth, canvasHeight)`, set initial `pixelSize = Math.min(DEFAULT_BLOCK_SIZE, maxBlockSize)`, trigger an initial preview.

- **`handlePixelSizeChange(raw: number)`:**
  1. Clamp: `v = Math.max(MIN_BLOCK_SIZE, Math.min(maxBlockSizeRef.current, Math.round(raw)))`.
  2. If `snapToGrid` is on, snap: `v = nearestDivisor(snapDivisorsRef.current, v)`.
  3. `setPixelSize(v)`.
  4. Debounce `runPreview(v)`.

- **`handleSnapChange(checked: boolean)`:**
  1. `setSnapToGrid(checked)`.
  2. If `checked` and `snapDivisorsRef.current.length > 0`, snap current `pixelSize` to nearest divisor. Update state and trigger debounced preview if the value changed.

- **`runPreview(size: number)`:** Same busy-guard + re-schedule pattern as `GaussianBlurDialog`. Calls `pixelate(original.slice(), canvasWidth, canvasHeight, size)`, then `applySelectionComposite`, then `handle.writeLayerPixels`.

- **`handleApply`:** Flush debounce timer, run `pixelate` one final time with current `pixelSize`, write pixels, call `captureHistory('Pixelate')`, call `onClose()`. On error, restore `original` and set `errorMessage`.

- **`handleCancel`:** Clear debounce timer, restore `originalPixels` to canvas, call `onClose()`. No history entry.

- **Escape key:** `useEffect` that adds a `keydown` listener calling `handleCancel` when `isOpen` is true.

**Dialog layout** (two-column, 452 px wide per UX design):

```tsx
<ToolWindow title="Pixelate" icon={<PixelateIcon />} onClose={handleCancel} width={452}>
  <div className={styles.body}>
    {/* Left: preview column */}
    <div className={styles.previewCol}>
      <div className={styles.previewCanvas}>
        {/* Visual-only: the actual canvas behind the modal shows the live preview.
            This area is a static label for the preview dimensions. */}
      </div>
      <div className={styles.previewFooter}>
        <span className={styles.previewLabel}>Preview</span>
        <span className={styles.previewDims}>{canvasWidth} × {canvasHeight}</span>
      </div>
    </div>

    {/* Right: controls column */}
    <div className={styles.controlsCol}>
      {/* Pixel Size */}
      <div className={styles.ctrlBlock}>
        <div className={styles.ctrlHeaderRow}>
          <label className={styles.ctrlLabel}>Pixel Size</label>
        </div>
        <div className={styles.sliderRow}>
          <input type="range" min={MIN_BLOCK_SIZE} max={maxBlockSize} step={1}
                 value={pixelSize}
                 onChange={e => handlePixelSizeChange(e.target.valueAsNumber)} />
          <input type="number" min={MIN_BLOCK_SIZE} max={maxBlockSize} step={1}
                 value={pixelSize}
                 onChange={e => handlePixelSizeChange(e.target.valueAsNumber)}
                 onBlur={e  => handlePixelSizeChange(e.target.valueAsNumber)} />
          <span className={styles.unit}>px</span>
        </div>
        <div className={styles.sliderRangeHint}>
          <span>{MIN_BLOCK_SIZE}</span>
          <span>{maxBlockSize}</span>
        </div>
      </div>

      {/* Snap to Grid */}
      <div className={styles.snapRow}>
        <input type="checkbox" id="snap-to-grid"
               checked={snapToGrid}
               disabled={snapDivisors.length === 0}
               onChange={e => handleSnapChange(e.target.checked)} />
        <label htmlFor="snap-to-grid"
               className={snapDivisors.length === 0 ? styles.snapLabelDisabled : styles.snapLabel}>
          Snap to Grid
        </label>
        {snapDivisors.length === 0 && (
          <span className={styles.snapNote}>
            No common divisors ≥ 2 for this image size.
          </span>
        )}
      </div>

      {/* Status messages */}
      {isBusy && <div className={styles.previewIndicator}>Previewing…</div>}
      {hasSelection && (
        <div className={styles.selectionNote}>
          Filter will apply inside the selection only.
        </div>
      )}
      {errorMessage != null && (
        <div className={styles.errorMessage}>{errorMessage}</div>
      )}
    </div>
  </div>

  <div className={styles.footer}>
    <button className={styles.btnCancel} onClick={handleCancel}>Cancel</button>
    <button className={styles.btnApply} onClick={() => { void handleApply() }} disabled={isBusy}>Apply</button>
  </div>
</ToolWindow>
```

Note on the snap slider: the native `<input type="range">` does not natively constrain to a non-uniform set of values. The snap enforcement happens in `handlePixelSizeChange` by calling `nearestDivisor`. The slider's visual thumb position will not snap to valid positions while dragging but the committed value (shown in the number input) always reflects a valid divisor when snap is on. This matches common app behavior and avoids the complexity of a custom slider widget.

---

### Step 7 — Create `PixelateDialog.module.scss` (`src/components/dialogs/PixelateDialog/PixelateDialog.module.scss`)

Styles for the two-column layout. Key classes:
- `.body` — `display: flex; gap: 0`
- `.previewCol` — `flex-shrink: 0; width: 220px; border-right: 1px solid var(--color-border)`
- `.previewCanvas` — `width: 220px; height: 165px` with checkerboard background for transparency
- `.previewFooter` — flex row, dims label on right
- `.controlsCol` — `flex: 1; padding: 10px; display: flex; flex-direction: column; gap: 8px`
- `.ctrlBlock`, `.ctrlHeaderRow`, `.ctrlLabel`, `.sliderRow`, `.sliderRangeHint`, `.unit` — mirror the styles from other filter dialogs
- `.snapRow` — `display: flex; align-items: center; gap: 7px; padding: 4px 0 2px`
- `.snapLabel`, `.snapLabelDisabled`, `.snapNote` — label styles; disabled label uses `color: var(--color-text-muted)`
- `.previewIndicator`, `.selectionNote`, `.errorMessage` — inline message boxes
- `.footer` — `display: flex; justify-content: flex-end; gap: 6px; padding: 7px 8px; border-top: 1px solid var(--color-border)`
- `.btnCancel`, `.btnApply` — match other dialog button styles

---

### Step 8 — Export from barrel (`src/components/index.ts`)

Add alongside the other filter dialog exports:
```ts
export { PixelateDialog } from './dialogs/PixelateDialog/PixelateDialog'
export type { PixelateDialogProps } from './dialogs/PixelateDialog/PixelateDialog'
```

---

### Step 9 — Wire into `App.tsx`

**9a.** Import:
```ts
import { PixelateDialog } from '@/components/dialogs/PixelateDialog/PixelateDialog'
```

**9b.** Add dialog state (alongside the other `show*Dialog` flags):
```ts
const [showPixelateDialog, setShowPixelateDialog] = useState(false)
```

**9c.** Add switch case inside `handleOpenFilterDialog`:
```ts
if (key === 'pixelate') setShowPixelateDialog(true)
```

**9d.** Add JSX at the end of the dialog block:
```tsx
{showPixelateDialog && (
  <PixelateDialog
    isOpen={showPixelateDialog}
    onClose={() => setShowPixelateDialog(false)}
    canvasHandleRef={canvasHandleRef}
    activeLayerId={state.activeLayerId}
    captureHistory={captureHistory}
    canvasWidth={state.canvas.width}
    canvasHeight={state.canvas.height}
  />
)}
```

---

## Architectural Constraints

**Per-block GPU dispatch (not per-pixel).** The naive per-pixel approach where each thread samples its entire block runs in O(W × H × S²) total GPU work. At the spec's maximum block size (`floor(min(W,H)/2)`) this is computationally infeasible on large images. The per-block dispatch limits total work to O(W × H) regardless of S, which is the correct algorithmic approach.

**No intermediate texture.** Pixelate is not separable, so a two-pass H+V approach (as used by Gaussian and box blur) does not apply. A single pass with block-origin dispatch produces the correct result without requiring the shared `intermediate0` texture that the engine pre-allocates.

**Common divisors stay in the dialog.** Per AGENTS.md, abstractions for one-time operations belong in the file that uses them. The `gcd`, `computeCommonDivisors`, and `nearestDivisor` functions are module-level helpers inside `PixelateDialog.tsx`. No new utility file is needed.

**Selection compositing pattern.** The dialog snapshots `selectionStore.mask` at open time (same as all other filter dialogs) and uses `applySelectionComposite` before writing to the canvas. Block boundaries are always relative to the layer origin (not the selection bounding box), as required by the spec, which falls out naturally since the shader operates on the full layer pixel buffer.

**`FilterKey` union must be extended.** The `handleOpenFilterDialog` dispatcher in `App.tsx` is typed on `FilterKey`. Adding `'pixelate'` to the union in `src/types/index.ts` makes the switch exhaustive and prevents silent no-ops if the key is mistyped.

**`group` type extension.** The `group` literal union in `FilterRegistryEntry` governs how the Filters menu separates items with dividers. Adding `'pixelate'` as a new group places the Pixelate item in its own menu section, consistent with how Photoshop treats it as a distinct filter category.

---

## Open Questions

1. **Debounce interval.** The spec says "short debounce delay". The current value `DEBOUNCE_MS = 25` matches `GaussianBlurDialog`. For very large images with large block sizes the GPU pass is still O(W×H), so 25 ms is acceptable, but if profiling shows perceptible jitter on low-end GPUs this can be raised to 100–150 ms without any structural change.

2. **Snap slider thumb position.** When snap is on, the slider thumb moves freely but the committed value snaps to the nearest divisor. A fully correct UX would show a discrete slider (tick marks only at valid divisor positions). That requires a custom widget, which is out of scope for the initial implementation. If this is deemed a UX regression from the design, a `<datalist>` approach could be explored for browsers that support it on range inputs.

3. **Unified rasterization pipeline.** The spec notes Pixelate as a destructive filter (not an adjustment layer). There is no non-destructive variant in scope. The unified rasterization pipeline (`src/rasterization/`) is therefore not involved. If a non-destructive "Pixelate Layer" is added in the future, it would require the standard adjustment registry integration described in AGENTS.md. This design does not touch the rasterization pipeline.
