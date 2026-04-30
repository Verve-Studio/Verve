# Technical Design: Object Selection Tool

## Overview

The Object Selection Tool adds AI-assisted selection to Verve using MobileSAM (Segment Anything Model — lightweight ONNX variant). The user drags a bounding box or places point prompts; MobileSAM's image encoder + mask decoder run locally to produce a pixel-accurate selection mask that is then committed to `selectionStore` exactly like any other selection tool.

Because Electron's sandboxed renderer process blocks `SharedArrayBuffer`, ONNX inference runs in the **main process** via `onnxruntime-node`. The renderer communicates with it over five IPC channels. The encoder pass (~500 ms) is cached per canvas state; the decoder (~50 ms) re-runs on each prompt change.

---

## Affected Areas

### New files

| File | Purpose |
|---|---|
| `electron/main/sam.ts` | All SAM inference logic: model loading, image preprocessing, encoder/decoder execution, embedding cache |
| `src/store/objectSelectionStore.ts` | Module-level singleton for in-progress prompt state (points, bounding box, overlay status, model readiness) |
| `src/hooks/useObjectSelection.ts` | IPC coordination: download, encode, decode, keyboard handling, mask commit |
| `src/tools/objectSelection.tsx` | Tool handler factory + Options UI component |

### Modified files

| File | Change |
|---|---|
| `electron/main/ipc.ts` | Register the five `sam:*` IPC handlers; delegate to `sam.ts` |
| `electron/preload/index.ts` | Expose the five `sam.*` methods and a `sam.onDownloadProgress` event listener on `window.api` |
| `src/types/index.ts` | Add `'object-selection'` to the `Tool` union; add `PromptPoint` and `SAMBoundingBox` types |
| `src/store/selectionStore.ts` | Add public method `setFromSAMMask(mask, mode, feather, antiAlias)` |
| `src/tools/index.ts` | Register `objectSelectionTool` in `TOOL_REGISTRY` |
| `src/components/window/Canvas/Canvas.tsx` | Add overlay `useEffect` for the `'object-selection'` tool (rect preview + point dots) |
| `src/components/window/Toolbar/Toolbar.tsx` | Add tool to `TOOL_GRID`; add icon; add `handleCycleObjectSelection` |
| `src/hooks/useKeyboardShortcuts.ts` | Add `handleCycleObjectSelection` option; wire the `W` key to cycle magic-wand ↔ object-selection |
| `src/App.tsx` | Pass `useObjectSelection` return values into the keyboard shortcuts hook and Canvas |

---

## Data Flow

```
┌─────────────────────────────── RENDERER ───────────────────────────────────┐
│                                                                              │
│  objectSelection.tsx handler                                                 │
│    onPointerDown / onPointerMove / onPointerUp                               │
│      │                                                                       │
│      ├─ [rect mode] objectSelectionStore.setDragRect(x1,y1,x2,y2)           │
│      │     └─ notify() → Canvas.tsx redraws dashed rect overlay              │
│      │                                                                       │
│      ├─ [rect mode, pointerUp] objectSelectionStore.commitRect(x1,y1,x2,y2) │
│      │     └─ useObjectSelection.triggerInference()                          │
│      │                                                                       │
│      └─ [point mode] objectSelectionStore.addPoint({x,y,positive})          │
│            └─ notify() → Canvas.tsx redraws point dots overlay               │
│            └─ useObjectSelection.debouncedInference() (300 ms)               │
│                                                                              │
│  useObjectSelection.runInference()                                           │
│    1. if (cache stale):                                                      │
│         a. rendererRef.readFlattenedPixels(layers)     → RGBA buffer        │
│         b. downsample to 1024×1024 via OffscreenCanvas                      │
│         c. window.api.sam.encodeImage(imageData, cw, ch)  ─────────────┐   │
│                                                                         │   │
│    2. window.api.sam.decodeMask(embeddings?, points, box?) ─────────┐  │   │
│                                                                      │  │   │
│    3. post-process returned mask                                     │  │   │
│         a. scale mask from 1024×1024 → canvas size (OffscreenCanvas)│  │   │
│         b. selectionStore.setFromSAMMask(mask, mode, feather, aa)   │  │   │
│         c. notify() → marching-ants overlay updates                  │  │   │
└──────────────────────────────────────────────────────────────────────│──│───┘
                                                                        │  │
         IPC (contextBridge)                                            │  │
┌─────────────────────────────── MAIN PROCESS ──────────────────────────│──│───┐
│                                                                        │  │   │
│  sam:encode-image  ◄───────────────────────────────────────────────────┘  │   │
│    1. receive raw 1024×1024 RGBA (4 bytes/px)                             │   │
│    2. normalize float32 [1,3,1024,1024] (ImageNet mean/std)               │   │
│    3. run encoder ONNX session → image_embeddings tensor                  │   │
│    4. cache embeddings keyed by (tabId + canvasVersion)                   │   │
│    5. return { embeddings: Buffer }  ──────────────────────────────────┐  │   │
│                                                                         │  │   │
│  sam:decode-mask  ◄──────────────────────────────────────────────────────┘  │   │
│    1. receive { embeddings?, points, box?, origW, origH }                │   │
│       (embeddings = null → use cached)                                    │   │
│    2. scale point/box coords from canvas space to 1024×1024 SAM space   │   │
│    3. build point_coords [1,N+1,2] + point_labels [1,N+1] tensors       │   │
│    4. run decoder ONNX session → masks [1,3,256,256] + iou_predictions  │   │
│    5. select mask with highest IoU score                                  │   │
│    6. sigmoid + threshold → float→uint8 (0–255 soft mask, 256×256)      │   │
│    7. return { mask: Buffer, width: 256, height: 256, iouScore: number } │   │
│                                                                           │   │
│  sam:check-model / sam:download-model / sam:invalidate-cache  ────────────┘   │
└───────────────────────────────────────────────────────────────────────────────┘
```

> **Note on mask resolution:** The decoder natively outputs at 256 × 256 (low-res masks). The renderer upsamples from 256 × 256 to canvas dimensions using an `OffscreenCanvas`. Passing `orig_im_size` to force decoder output at full canvas resolution works but produces large float32 tensors over IPC (e.g. 48 MB for a 4096 × 4096 canvas). The 256 × 256 + renderer upsample approach is simpler and keeps IPC payloads small (~64 KB per mask). See Open Questions for quality trade-offs.

---

## IPC Message Types

Add these TypeScript types to `electron/preload/index.ts` (inline, not a shared types file — the preload is not bundled with the renderer):

```typescript
// ─── SAM types (used in preload only) ────────────────────────────────────────

interface SAMPromptPoint {
  /** Canvas-space X coordinate */
  x: number
  /** Canvas-space Y coordinate */
  y: number
  /** true = positive (include), false = negative (exclude) */
  positive: boolean
}

interface SAMBoundingBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

interface SAMModelStatus {
  encoderReady: boolean
  decoderReady: boolean
}

interface SAMDownloadProgress {
  file: 'encoder' | 'decoder'
  /** 0.0 – 1.0 */
  progress: number
}

interface SAMEncodeResult {
  /** Float32Array serialized as Buffer (shape: [1, 256, 64, 64]) */
  embeddings: Buffer
}

interface SAMDecodeResult {
  /** Uint8Array serialized as Buffer; canvas-sized, 1 byte per pixel (0–255 soft mask) */
  mask: Buffer
  width: number
  height: number
  iouScore: number
}
```

### IPC handler signatures (main process, `electron/main/sam.ts`)

```typescript
// sam:check-model → SAMModelStatus
ipcMain.handle('sam:check-model', (): Promise<SAMModelStatus>)

// sam:download-model — streams progress events, resolves when complete
// Progress events: ipcMain.on('sam:download-progress', { file, progress })
ipcMain.handle('sam:download-model', (event): Promise<{ success: true } | { error: string }>)

// sam:encode-image → SAMEncodeResult
// imageData: Uint8Array, 1024×1024 RGBA (4 bytes/px = 4,194,304 bytes)
// origWidth, origHeight: original canvas dimensions (for coord scaling in decode)
ipcMain.handle('sam:encode-image',
  (_event, imageData: Buffer, origWidth: number, origHeight: number): Promise<SAMEncodeResult>
)

// sam:decode-mask → SAMDecodeResult
// embeddings: null → use cached embeddings
// points: array of prompt points in CANVAS space
// box: optional bounding box in CANVAS space
// origWidth, origHeight: canvas dimensions (for scaling)
ipcMain.handle('sam:decode-mask',
  (_event, params: {
    embeddings: Buffer | null
    points: SAMPromptPoint[]
    box: SAMBoundingBox | null
    origWidth: number
    origHeight: number
  }): Promise<SAMDecodeResult>
)

// sam:invalidate-cache — clears cached image embeddings
ipcMain.handle('sam:invalidate-cache', (): void)
```

### Preload additions (`electron/preload/index.ts`)

Add to the `api` object:

```typescript
sam: {
  checkModel: (): Promise<SAMModelStatus> =>
    ipcRenderer.invoke('sam:check-model'),

  downloadModel: (): Promise<{ success: true } | { error: string }> =>
    ipcRenderer.invoke('sam:download-model'),

  encodeImage: (
    imageData: Uint8Array, origWidth: number, origHeight: number
  ): Promise<SAMEncodeResult> =>
    ipcRenderer.invoke('sam:encode-image', Buffer.from(imageData.buffer), origWidth, origHeight),

  decodeMask: (params: {
    embeddings: Buffer | null
    points: SAMPromptPoint[]
    box: SAMBoundingBox | null
    origWidth: number
    origHeight: number
  }): Promise<SAMDecodeResult> =>
    ipcRenderer.invoke('sam:decode-mask', params),

  invalidateCache: (): Promise<void> =>
    ipcRenderer.invoke('sam:invalidate-cache'),

  onDownloadProgress: (callback: (p: SAMDownloadProgress) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, p: SAMDownloadProgress): void => callback(p)
    ipcRenderer.on('sam:download-progress', handler)
    return () => ipcRenderer.removeListener('sam:download-progress', handler)
  },
},
```

---

## State Changes

### `src/types/index.ts`

1. Add `'object-selection'` to the `Tool` union (between `'magic-wand'` and `'crop'`).
2. Add shared prompt types (imported by both the store and the hook):

```typescript
export interface PromptPoint {
  x: number
  y: number
  positive: boolean
}

export interface SAMBoundingBox {
  x1: number
  y1: number
  x2: number
  y2: number
}
```

No new `AppState` fields are needed. All transient interaction state lives in `objectSelectionStore` (module-level singleton). Model readiness is queried lazily via IPC on tool activation.

### `src/store/selectionStore.ts`

Add one new **public** method. Both `applyFeather` and `applyMask` are currently `private`; the SAM mask path needs to call them:

```typescript
/**
 * Apply a SAM-produced mask to the selection.
 * rawMask must be canvas-sized (width × height), 0–255 per pixel.
 * Anti-alias applies a 1-pixel Gaussian when feather is 0.
 */
setFromSAMMask(
  rawMask: Uint8Array,
  mode: SelectionMode = 'set',
  feather = 0,
  antiAlias = true,
): void {
  this.pending = null
  const m = new Uint8Array(rawMask)               // copy; don't mutate caller's buffer
  if (antiAlias && feather === 0) this.applyFeather(m, 1)
  if (feather > 0)                this.applyFeather(m, feather)
  this.applyMask(m, mode)
  this.notify()
}
```

`applyFeather` and `applyMask` remain `private`; only the new public entry-point is added.

---

## New Files — Implementation Details

### `electron/main/sam.ts`

This is the only file in the main process that touches ONNX Runtime. Keep all SAM logic here; `ipc.ts` delegates to functions exported from `sam.ts`.

**Responsibilities:**
- Load `onnxruntime-node` lazily on first use (avoid startup cost).
- Manage the two `InferenceSession` instances: `encoderSession` and `decoderSession`.
- Maintain a single embedding cache entry: `{ embeddings: Float32Array; version: number }`. One entry is sufficient; the version counter is bumped by `sam:invalidate-cache`.

**Model file paths:**
```typescript
import { app } from 'electron'
import { join } from 'node:path'

const MODELS_DIR = join(app.getPath('userData'), 'models', 'mobilesam')
const ENCODER_PATH = join(MODELS_DIR, 'encoder.onnx')
const DECODER_PATH = join(MODELS_DIR, 'decoder.onnx')
```

**TODO — Model URLs (must be verified before implementation):**
The ONNX-format MobileSAM encoder and decoder are available from the HuggingFace Hub, but the exact canonical URLs should be confirmed at implementation time. Two known candidate sources are:
- `https://huggingface.co/vietanhdev/anything-sam/resolve/main/encoder.onnx`
- `https://huggingface.co/vietanhdev/anything-sam/resolve/main/decoder.onnx`

Verify these files are genuine ONNX models and check their sizes before hardcoding the URLs. Use `node:crypto`'s SHA-256 to verify integrity after download.

**Download implementation:**
```typescript
import { net } from 'electron'
import { createWriteStream, unlink } from 'node:fs'
import { mkdir } from 'node:fs/promises'

async function downloadFile(
  url: string, dest: string,
  onProgress: (p: number) => void,
): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true })
  const tmp = dest + '.tmp'
  // Use net.request (Electron's Chromium network stack) so it respects proxy settings.
  // Stream to a .tmp file; rename to final name only on success.
  // On failure: unlink(tmp) and rethrow.
}
```

Use `net.request` (not `https`) — it respects the user's system proxy settings.

**Image preprocessing (for encoder):**
```
Input:  1024×1024 RGBA Uint8Array  (from renderer)
Output: Float32Array [1, 3, 1024, 1024]  (CHW layout, ImageNet-normalized)

mean = [0.485, 0.456, 0.406]
std  = [0.229, 0.224, 0.225]

for each pixel i:
  r = (rgba[4i+0] / 255.0 - mean[0]) / std[0]
  g = (rgba[4i+1] / 255.0 - mean[1]) / std[1]
  b = (rgba[4i+2] / 255.0 - mean[2]) / std[2]
  tensor[0 * H * W + i] = r
  tensor[1 * H * W + i] = g
  tensor[2 * H * W + i] = b
```

**Prompt coordinate scaling (for decoder):**
Encoder received a 1024×1024 image that was the canvas resized to fit 1024×1024 preserving aspect ratio (letterbox / pillarbox). The scale factor is:
```
scale = 1024 / max(origWidth, origHeight)
// Point transform (canvas space → SAM input space):
ptX_sam = ptX_canvas * scale
ptY_sam = ptY_canvas * scale
```

**Decoder input tensors:**
```
image_embeddings  Float32  [1, 256, 64, 64]  (from encoder cache)
image_pe          Float32  [1, 256, 64, 64]  (positional encoding — from encoder output or fixed)
point_coords      Float32  [1, N+1, 2]       (N prompts + 1 padding point at [0,0])
point_labels      Float32  [1, N+1]          (1=positive, 0=negative, -1=padding)
mask_input        Float32  [1, 1, 256, 256]  (all zeros — no prior mask input)
has_mask_input    Float32  [1]               (= 0.0)
orig_im_size      Float32  [2]               (= [1024.0, 1024.0])
```

Pass `orig_im_size = [1024, 1024]` — the decoder outputs a 256 × 256 low-res mask (its internal upsampling target). The renderer handles upsampling to canvas size, keeping IPC payloads small.

> **Note on `image_pe`:** The standard SAM ONNX decoder includes `image_pe` as a separate input. For the `vietanhdev/anything-sam` exports, check whether `image_pe` is included in the decoder or is a fixed constant embedded in the model. If it is a standalone input, the encoder must output it; verify the encoder outputs `image_embeddings` and `interm_embeddings` (or similar).

**Decoder output processing:**
```
masks        Float32  [1, 3, 256, 256]   (3 candidates, pre-sigmoid logits)
iou_predictions Float32 [1, 3]

best_idx = argmax(iou_predictions[0])
mask = masks[0][best_idx]               // Float32[256*256]
// Apply sigmoid and convert to Uint8:
for i in range(256*256):
  val = 1.0 / (1.0 + exp(-mask[i]))    // sigmoid
  uint8_mask[i] = clamp(round(val * 255), 0, 255)
```

Return `{ mask: Buffer.from(uint8_mask), width: 256, height: 256, iouScore }`.

---

### `src/store/objectSelectionStore.ts`

Module-level class singleton. Stores all mutable overlay state for the active session. Follows the same `subscribe/unsubscribe/notify()` pattern as `polygonalSelectionStore`.

```typescript
type ModelStatus = 'unknown' | 'checking' | 'downloading' | 'ready' | 'error'
type PromptMode  = 'rect' | 'point'
type InferenceStatus = 'idle' | 'running' | 'error'

class ObjectSelectionStore {
  // ── Model status (persists across sessions) ──────────────────────────────
  modelStatus: ModelStatus = 'unknown'
  downloadProgress: { file: 'encoder' | 'decoder'; progress: number } | null = null
  modelError: string | null = null

  // ── Session state (reset on tool deactivation) ───────────────────────────
  promptMode: PromptMode = 'rect'
  points: PromptPoint[] = []
  dragRect: { x1: number; y1: number; x2: number; y2: number } | null = null
  isDragging = false

  // ── Inference state ───────────────────────────────────────────────────────
  inferenceStatus: InferenceStatus = 'idle'
  /** Soft mask from last successful decode (canvas-sized Uint8Array), null if none. */
  pendingMask: Uint8Array | null = null

  // ── Cache version (bumped whenever the canvas content changes) ────────────
  cacheVersion = 0

  private listeners = new Set<() => void>()
  subscribe(fn: () => void): void   { this.listeners.add(fn) }
  unsubscribe(fn: () => void): void { this.listeners.delete(fn) }
  notify(): void                    { for (const fn of this.listeners) fn() }

  reset(): void {
    this.points = []
    this.dragRect = null
    this.isDragging = false
    this.inferenceStatus = 'idle'
    this.pendingMask = null
    this.notify()
  }

  setDragRect(x1: number, y1: number, x2: number, y2: number): void {
    this.dragRect = { x1, y1, x2, y2 }
    this.isDragging = true
    this.notify()
  }

  endDrag(): void {
    this.isDragging = false
    this.notify()
  }

  addPoint(p: PromptPoint): void {
    this.points = [...this.points, p]
    this.notify()
  }

  removeLastPoint(): void {
    this.points = this.points.slice(0, -1)
    this.notify()
  }

  invalidateCache(): void {
    this.cacheVersion++
    this.pendingMask = null
  }
}

export const objectSelectionStore = new ObjectSelectionStore()
```

---

### `src/hooks/useObjectSelection.ts`

Owns all IPC coordination. This hook is called once in `App.tsx` (similar to `usePolygonalSelection`). It returns methods that `App.tsx` passes into `useKeyboardShortcuts` and, indirectly, into `Canvas.tsx` props if needed (though the tool handler calls methods on `objectSelectionStore` directly).

**Responsibilities:**
1. On first render: call `sam:check-model` and update `objectSelectionStore.modelStatus`.
2. `downloadModel()`: call `sam:download-model`, subscribe to `onDownloadProgress`, update store.
3. `runInference(mode)`: acquire flattened canvas pixels → downsample to 1024×1024 → IPC encode (if cache stale) → IPC decode → upsample → write to `objectSelectionStore.pendingMask` → call `selectionStore.setFromSAMMask` with mode `'set'` as preview (marching ants update live during session).
4. `commitSelection(selectionMode)`: call `selectionStore.setFromSAMMask` with the active selection mode; call `historyStore.push()`; call `objectSelectionStore.reset()`.
5. `cancelSelection()`: call `objectSelectionStore.reset()`; call `selectionStore.setPending(null)`.
6. Handle keyboard events: `Enter` → commit, `Escape` → cancel, `Backspace/Delete` in point mode → remove last point + re-run inference.
7. `invalidateCache()`: call `sam:invalidate-cache` IPC + `objectSelectionStore.invalidateCache()`.

**Cache invalidation triggers** (wired up in `useObjectSelection`):
- Subscribe to `onStrokeEnd` from `Canvas.tsx` props — call `invalidateCache()` when a stroke ends.
- Subscribe to layer list changes via a `useEffect` on `state.layers`.
- Subscribe to active tab changes.

**Canvas pixel acquisition:**
```typescript
// Flatten all visible layers to a composite RGBA buffer, then downsample to 1024×1024.
async function getFlattenedImage1024(
  renderer: WebGPURenderer,
  layers: GpuLayer[],
  canvasWidth: number,
  canvasHeight: number,
): Promise<{ data: Uint8Array; scale: number }> {
  const rgba = await renderer.readFlattenedPixels(layers)  // canvasWidth × canvasHeight × 4
  // Draw into an OffscreenCanvas at 1024×1024 using drawImage for bilinear downscale.
  const oc = new OffscreenCanvas(1024, 1024)
  const ctx = oc.getContext('2d')!
  const imgData = new ImageData(
    new Uint8ClampedArray(rgba.buffer), canvasWidth, canvasHeight
  )
  const bmp = await createImageBitmap(imgData, {
    resizeWidth: 1024, resizeHeight: 1024, resizeQuality: 'medium'
  })
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  const out = ctx.getImageData(0, 0, 1024, 1024)
  return { data: new Uint8Array(out.data.buffer), scale: 1024 / Math.max(canvasWidth, canvasHeight) }
}
```

**Mask upsampling (256×256 → canvas size):**
```typescript
async function upsampleMask(
  mask256: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
): Promise<Uint8Array> {
  // Create a 256×256 grayscale image → draw into OffscreenCanvas at canvas size.
  const rgba256 = new Uint8ClampedArray(256 * 256 * 4)
  for (let i = 0; i < 256 * 256; i++) {
    rgba256[i * 4 + 0] = mask256[i]
    rgba256[i * 4 + 1] = mask256[i]
    rgba256[i * 4 + 2] = mask256[i]
    rgba256[i * 4 + 3] = 255
  }
  const bmp = await createImageBitmap(
    new ImageData(rgba256, 256, 256),
    { resizeWidth: canvasWidth, resizeHeight: canvasHeight, resizeQuality: 'medium' }
  )
  const oc = new OffscreenCanvas(canvasWidth, canvasHeight)
  oc.getContext('2d')!.drawImage(bmp, 0, 0)
  bmp.close()
  const px = oc.getContext('2d')!.getImageData(0, 0, canvasWidth, canvasHeight)
  // Extract the red channel as the mask.
  const out = new Uint8Array(canvasWidth * canvasHeight)
  for (let i = 0; i < out.length; i++) out[i] = px.data[i * 4]
  return out
}
```

**Debounce (point mode):**
Use a module-level `let debounceTimer: ReturnType<typeof setTimeout> | null = null`. On each new point: `clearTimeout(debounceTimer); debounceTimer = setTimeout(runInference, 300)`.

**"Select Subject" implementation:**
Pass zero prompt points to the decoder with no bounding box. SAM's decoder requires at least one prompt; use the canvas center as a single implicit positive point:
```typescript
const centerPoint: PromptPoint = {
  x: canvasWidth / 2,
  y: canvasHeight / 2,
  positive: true,
}
// Internal — not shown in the overlay or added to objectSelectionStore.points.
```
See Open Questions for the expected behavior.

---

### `src/tools/objectSelection.tsx`

Follows the exact same pattern as `polygonalSelection.tsx` and `select.tsx`.

**Module-level options object:**
```typescript
export const objectSelectionOptions = {
  mode: 'set' as SelectionMode,
  feather: 0,
  antiAlias: true,
  promptMode: 'rect' as 'rect' | 'point',
}
```

**Handler factory — `createObjectSelectionHandler()`:**

The handler is a plain object with pointer callbacks. It calls methods on `objectSelectionStore`; the `useObjectSelection` hook reacts via the store's `notify()`.

```typescript
function createObjectSelectionHandler(): ToolHandler {
  return {
    onPointerDown({ x, y, altKey }: ToolPointerPos) {
      if (objectSelectionStore.modelStatus !== 'ready') return
      const mode = objectSelectionOptions.promptMode
      if (mode === 'rect') {
        objectSelectionStore.setDragRect(x, y, x, y)
      } else {
        // point mode — Alt+click = negative
        objectSelectionStore.addPoint({ x, y, positive: !altKey })
        // inference is debounced in useObjectSelection via store subscription
      }
    },

    onPointerMove({ x, y }: ToolPointerPos) {
      if (!objectSelectionStore.isDragging) return
      const r = objectSelectionStore.dragRect!
      objectSelectionStore.setDragRect(r.x1, r.y1, x, y)
    },

    onPointerUp({ x, y }: ToolPointerPos) {
      if (!objectSelectionStore.isDragging) return
      const r = objectSelectionStore.dragRect!
      // Reject sub-threshold boxes
      if (Math.abs(x - r.x1) < 8 || Math.abs(y - r.y1) < 8) {
        objectSelectionStore.endDrag()
        return
      }
      objectSelectionStore.endDrag()
      // useObjectSelection is subscribed to the store and will trigger inference
    },
  }
}
```

**Options UI component — `ObjectSelectionOptions`:**

```
[Mode: New|Add|Sub|Int] | [Prompt: Rect|Point] | [Feather: slider] | [Anti-alias ✓] | [Subject] | [✓] [✗]
```

- When `objectSelectionStore.modelStatus !== 'ready'`: render download/progress UI only.
- When `inferenceStatus === 'running'`: show "Analyzing…" text in options bar.
- **✓ Commit** button: visible when `pendingMask !== null` in point mode.
- **✗ Cancel** button: always visible in point mode when session is active.
- **Subject** button: always visible when model is ready; calls `useObjectSelection.runSelectSubject()` (passed via a ref or context — see below).

**Connecting the Options UI to `useObjectSelection`:** The options UI needs to call `commitSelection`, `cancelSelection`, `downloadModel`, and `runSelectSubject`. Because the options component is instantiated by the tool registry (not by `App.tsx`), these callbacks cannot be passed as props in the normal way. Use a **module-level callbacks ref** in `objectSelection.tsx`:

```typescript
// Callbacks set by useObjectSelection during hook initialization.
export const objectSelectionCallbacks = {
  commit:         (_mode: SelectionMode) => {},
  cancel:         () => {},
  downloadModel:  () => {},
  runSubject:     () => {},
}
```

`useObjectSelection` overwrites these properties after initialization. The Options UI reads them directly. This is the same pattern used by tools that need to call into hook logic (e.g. content-aware fill).

---

### Canvas overlay (`Canvas.tsx`)

Add a new `useEffect` for the `'object-selection'` tool, following the same pattern as the `polygonal-selection` overlay. Wire it to `objectSelectionStore.subscribe(redraw)`.

**Rectangle drag preview:** Drawn as a dashed blue rectangle (same stroke style as the Rectangular Marquee pending preview — 1 px white + dark dashed outline). Use `selectionStore.setPending({ type: 'rect', ... })` while dragging so the existing marching-ants canvas already renders it for free. Clear the pending on pointer-up.

**Point prompt dots:** Drawn in the `toolOverlayRef` canvas at the pixel coords stored in `objectSelectionStore.points`. Green dots for positive, red for negative:
```
// Positive point:
ctx2d.fillStyle = 'rgba(0, 200, 80, 0.9)'
// Negative point:
ctx2d.fillStyle = 'rgba(220, 50, 50, 0.9)'
// dot: arc radius 5, white 1.5px stroke
```

Clear the overlay on tool deactivation (effect cleanup).

---

## Toolbar and Keyboard Shortcut Changes

### `src/types/index.ts` — Tool union

```typescript
export type Tool =
  | 'move'
  | 'select'
  | 'lasso'
  | 'polygonal-selection'
  | 'object-selection'    // ← add here, between polygonal-selection and magic-wand
  | 'magic-wand'
  | ...
```

### `src/components/window/Toolbar/Toolbar.tsx` — TOOL_GRID

The spec places Object Selection between Lasso and Magic Wand. Restructure the relevant rows:

```typescript
// Before:
[
  { id: 'polygonal-selection', label: 'Polygonal Lasso',  shortcut: 'L', icon: Icon.polygonalLasso },
  { id: 'magic-wand',          label: 'Magic Wand',       shortcut: 'W', icon: Icon.magicWand }
],

// After:
[
  { id: 'polygonal-selection', label: 'Polygonal Lasso',  shortcut: 'L', icon: Icon.polygonalLasso },
  { id: 'object-selection',    label: 'Object Selection', shortcut: 'W', icon: Icon.objectSelection }
],
[
  { id: 'magic-wand',          label: 'Magic Wand',       shortcut: 'W', icon: Icon.magicWand },
  null,
],
```

Add an SVG icon `Icon.objectSelection` — a dashed rectangle with a sparkle or AI indicator:
```typescript
objectSelection: (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
    <rect x="1" y="1" width="14" height="14" rx="1" strokeDasharray="3 2" />
    <circle cx="11.5" cy="4.5" r="1" fill="currentColor" />
    <path d="M9 7l1.5 1.5L13 5" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" />
  </svg>
),
```

### `src/hooks/useKeyboardShortcuts.ts` — W key cycling

Add `handleCycleObjectSelection` alongside the existing `handleCycleLasso` option. Wire the bare `W` / `w` key (no modifier):

```typescript
// In the handler body:
if (e.key === 'w' || e.key === 'W') {
  e.preventDefault()
  handleCycleObjectSelection?.()
  return
}
```

In `App.tsx`, the `handleCycleObjectSelection` callback:
```typescript
const handleCycleObjectSelection = (): void => {
  const current = state.activeTool
  if (current === 'magic-wand') {
    dispatch({ type: 'SET_TOOL', payload: 'object-selection' })
  } else if (current === 'object-selection') {
    dispatch({ type: 'SET_TOOL', payload: 'magic-wand' })
  } else {
    dispatch({ type: 'SET_TOOL', payload: 'object-selection' })
  }
}
```

### `src/tools/index.ts`

```typescript
import { objectSelectionTool } from './objectSelection'

export const TOOL_REGISTRY: Record<Tool, ToolDefinition> = {
  ...
  'object-selection': objectSelectionTool,
  ...
}
```

---

## Implementation Steps

1. **`src/types/index.ts`** — Add `'object-selection'` to `Tool` union. Add `PromptPoint` and `SAMBoundingBox` types.

2. **`src/store/selectionStore.ts`** — Add `setFromSAMMask(rawMask, mode, feather, antiAlias)` public method.

3. **`electron/main/sam.ts`** (new file) — Implement `checkModel`, `downloadModels`, `encodeImage`, `decodeMask`, `invalidateCache`. Keep ONNX sessions lazily loaded. Use `net.request` for download, stream progress via `event.sender.send('sam:download-progress', ...)`. Normalize images with ImageNet mean/std before passing to encoder.

4. **`electron/main/ipc.ts`** — Import functions from `sam.ts` and register the five handlers.

5. **`electron/preload/index.ts`** — Expose `window.api.sam.*` as described above.

6. **`src/store/objectSelectionStore.ts`** (new file) — Implement as described above.

7. **`src/hooks/useObjectSelection.ts`** (new file) — Implement model-check-on-mount, download flow, `runInference` (encode + decode + upsample), `commitSelection`, `cancelSelection`, keyboard event handler, cache-invalidation wiring. Export `objectSelectionCallbacks` setters.

8. **`src/tools/objectSelection.tsx`** (new file) — Handler factory + Options UI + `objectSelectionOptions` + `objectSelectionCallbacks`.

9. **`src/tools/index.ts`** — Register `objectSelectionTool`.

10. **`src/components/window/Canvas/Canvas.tsx`** — Add the `'object-selection'` overlay `useEffect` (point dots + rect drag via `selectionStore.setPending`). Subscribe/unsubscribe `objectSelectionStore`. Add `objectSelectionStore` import. Cancel any active session on tool switch (the existing `polygonal-selection` cancel pattern in the cleanup for `activeTool !== 'object-selection'`).

11. **`src/components/window/Toolbar/Toolbar.tsx`** — Restructure `TOOL_GRID` rows, add `Icon.objectSelection` SVG.

12. **`src/hooks/useKeyboardShortcuts.ts`** — Add `handleCycleObjectSelection` parameter; wire `W` key.

13. **`src/App.tsx`** — Call `useObjectSelection(...)`. Pass `handleCycleObjectSelection` to `useKeyboardShortcuts`. Pass `invalidateCache` to `Canvas.tsx`'s `onStrokeEnd` (or subscribe inside the hook).

---

## Architectural Constraints

From `AGENTS.md`:

- **Tool handler is a plain object with no React** — `createObjectSelectionHandler()` must not call `useState`, `useRef`, or any React hook. All state lives in `objectSelectionStore`.
- **Module-level options object** — `objectSelectionOptions` is exported so `Canvas.tsx` can read the active feather/antiAlias settings for cursor or pending display if needed.
- **Hook owns the IPC concern** — `useObjectSelection` is the only place that calls `window.api.sam.*`. The tool handler and store do not touch IPC.
- **Canvas overlay via store subscription** — The overlay `useEffect` in `Canvas.tsx` subscribes to `objectSelectionStore` and redraws on every notify. This is the same as `polygonalSelectionStore` and `cloneStampStore`.
- **IPC in main process only** — ONNX Runtime must not be loaded in the renderer. No `onnxruntime-web` import anywhere in `src/`.
- **No direct file-system access in renderer** — All model file I/O (download, existence checks) goes through IPC handlers.
- **Undo** — `commitSelection` must call `historyStore.push(label)` after writing to `selectionStore`, consistent with all other selection tools.
- **Tab isolation** — When `useTabs` switches the active tab, `useObjectSelection` must call `invalidateCache()` and `objectSelectionStore.reset()`. Wire this by watching `state.canvas.key` or tab ID changes.

---

## Open Questions and Risks

### 1. Verified model URLs (MUST resolve before implementation)
The ONNX encoder and decoder URLs listed in this document (`vietanhdev/anything-sam`) have not been verified to be in the correct format or currently available. Confirm the exact file URLs, verify they are ONNX v1.x compatible with `onnxruntime-node`, and record their SHA-256 checksums before implementation. File a follow-up if alternative exports (e.g. from the official MobileSAM HuggingFace repo `ChaoningZhang/MobileSAM`) are better maintained.

### 2. `image_pe` (image positional encoding) input
The standard SAM decoder ONNX requires `image_pe` as a separate input (shape `[1, 256, 64, 64]`). Some ONNX export tools bake the positional encoding as a constant in the decoder graph (no external input needed); others include it in the encoder's outputs. Before implementing `sam.ts`, load the decoder ONNX with `onnxruntime-node` and inspect `session.inputNames` to determine whether `image_pe` must be passed explicitly, and if so, whether it comes from the encoder outputs or is a fixed constant.

### 3. "Select Subject" with no user prompts
SAM's decoder requires at least one point prompt. The approach documented here (pass the canvas center as an implicit positive point) reliably finds a subject in many images, but may return a background region if the center is in an empty area. An alternative is to run MobileSAM's **automatic mask generator** (grid of prompts across the whole image, then pick the highest-IoU mask), which is more robust but slower (~2–3 s). Flag this for UX testing and consider exposing a fallback toggle.

### 4. Mask output resolution (256×256 vs. canvas size)
This design returns a 256 × 256 low-res mask and upsamples in the renderer. At large canvas sizes (2000+ px) this can produce slightly soft object boundaries. An alternative is to pass `orig_im_size = [canvasH, canvasW]` to the decoder and receive a full-resolution mask. For canvases ≤ 2048 × 2048 the extra IPC payload is ≤ 4 MB which is acceptable. Evaluate quality at typical canvas sizes during implementation and choose accordingly.

### 5. First-time encoding latency
The encoder takes ~500 ms on a modern CPU. A "Analyzing…" indicator in the options bar is specified, but 500 ms is noticeable. Evaluate running the encoder on Node.js worker threads (`worker_threads`) or using `onnxruntime-node`'s built-in async execution APIs to avoid blocking the main process event loop during encoding (which would freeze native menus and the OS progress spinner).

### 6. Memory on large canvases
Sending a 4096 × 4096 RGBA buffer over Electron IPC serializes 67 MB of data. The design mitigates this by downsampling to 1024 × 1024 in the renderer (4 MB) before sending. Verify that `createImageBitmap` with `resizeQuality: 'medium'` is available in Electron's renderer context and produces acceptable quality at the target 1024 × 1024 size.

### 7. onnxruntime-node installation and packaging
`onnxruntime-node` ships native `.node` binaries for each platform/arch. Ensure it is added to `package.json` as a production dependency (not devDependency), and that `electron-builder` / the packaging config includes the `node_modules/onnxruntime-node/bin/` directory in the built app. The native addon path must be resolved with `app.getAppPath()` at runtime, not with a hard-coded relative path.

### 8. CSP and ONNX in renderer (alternative path evaluation)
If future Electron versions relax `SharedArrayBuffer` restrictions in non-sandboxed renderer contexts (or if the app can be run with `nodeIntegration: true`), `onnxruntime-web` with WebAssembly backend could run directly in the renderer, eliminating the IPC round-trip and improving latency. This path should be re-evaluated when targeting Electron 30+, as the current IPC design adds 10–50 ms overhead per encode/decode call due to serialization.
