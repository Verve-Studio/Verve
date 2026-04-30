# Project Structure

Verve is a desktop image editor built with **Electron 36**, **React 19**, **TypeScript**, **WebGPU**, and **C++/WASM**. It targets professional raster image editing on par with tools like Photoshop.

---

## Process model

Electron splits every app into (at minimum) two processes. Understanding this boundary is essential before reading any code.

```
┌─────────────────────────────────────────────────────────────┐
│  Main process (Node.js)          electron/main/             │
│  ─ Native file I/O & dialogs                                │
│  ─ IPC handler registration                                 │
│  ─ ML model inference (SAM, RVM)                            │
│  ─ Native application menu (macOS)                          │
└──────────────────┬──────────────────────────────────────────┘
                   │  IPC (contextBridge)
┌──────────────────▼──────────────────────────────────────────┐
│  Preload bridge              electron/preload/index.ts      │
│  ─ Exposes window.api to the renderer                       │
│  ─ No direct DOM access, no direct Node access              │
└──────────────────┬──────────────────────────────────────────┘
                   │  window.api.*
┌──────────────────▼──────────────────────────────────────────┐
│  Renderer process (Chromium)     src/                       │
│  ─ React 19 UI                                              │
│  ─ WebGPU canvas rendering                                  │
│  ─ All tool and layer logic                                 │
└─────────────────────────────────────────────────────────────┘
```

**Rule:** Never import from `electron/` inside `src/`. The renderer calls `window.api.*` for everything that needs Node.js. Never call `window.api` from `electron/main/` or `electron/preload/`.

---

## Repository layout

```
Verve/
├── electron/
│   ├── main/
│   │   ├── index.ts          ← Electron app lifecycle, BrowserWindow creation
│   │   ├── ipc.ts            ← All ipcMain.handle() registrations
│   │   ├── menu.ts           ← Native macOS/Windows menu construction
│   │   ├── sam.ts            ← SAM (Segment Anything) ONNX inference
│   │   └── matting.ts        ← RVM (Robust Video Matting) ONNX inference
│   └── preload/
│       ├── index.ts          ← contextBridge.exposeInMainWorld('api', {...})
│       └── index.d.ts        ← TypeScript declaration for window.api
│
├── src/                      ← Renderer (React app) — all UI, tools, GPU
│   ├── App.tsx               ← Thin orchestrator: hooks + layout
│   ├── main.tsx              ← ReactDOM.createRoot entry point
│   ├── env.d.ts              ← Vite asset import type declarations
│   │
│   ├── core/
│   │   ├── io/               ← Export helpers: exportPng, exportJpeg, exportWebp, exportTiff, exportTga, imageLoader
│   │   ├── operations/
│   │   │   ├── adjustments/  ← ADJUSTMENT_REGISTRY + curves data
│   │   │   └── filters/      ← FILTER_REGISTRY
│   │   ├── services/         ← All business-logic hooks (20+)
│   │   └── store/            ← AppContext, CanvasContext, all singletons, tabTypes
│   │
│   ├── graphicspipeline/
│   │   ├── rasterization/    ← Unified flatten/merge/export pipeline
│   │   └── webgpu/           ← WebGPURenderer, AdjustmentEncoder, filterCompute, shaders
│   │
│   ├── styles/               ← global.scss, _variables.scss, _mixins.scss
│   ├── tools/                ← Tool handlers + options UIs + algorithm/
│   ├── types/                ← index.ts — all shared TypeScript types
│   ├── utils/                ← layerTree, paletteFormat, color utilities, etc.
│   │
│   ├── ux/
│   │   ├── index.ts          ← Barrel export of every component
│   │   ├── main/             ← Layout chrome: Canvas, TopBar, Toolbar, RightPanel, etc.
│   │   ├── modals/           ← Blocking dialogs (NewImage, Export, Resize, About, …)
│   │   ├── widgets/          ← Stateless reusable primitives (SliderInput, ColorSwatch, …)
│   │   └── windows/
│   │       ├── adjustments/  ← 11 adjustment-layer panels
│   │       ├── effects/      ← 7 real-time effect option panels
│   │       └── filters/      ← 16 filter dialogs
│   │
│   └── wasm/
│       ├── index.ts          ← High-level async wrappers (floodFill, gaussianBlur, …)
│       ├── types.ts          ← PixelOpsModule WASM interface
│       └── generated/        ← gitignored; produced by npm run build:wasm
│
├── wasm/
│   ├── CMakeLists.txt        ← Emscripten build definition
│   └── src/                  ← C++17 pixel operations (fill, filters, resize, inpaint, …)
│
├── docs/
│   ├── developerguides/      ← This directory
│   ├── specifications/       ← Product feature specs
│   ├── technical-design/     ← Architecture & technical design docs
│   └── designs/              ← HTML UX mockups
│
├── electron.vite.config.ts   ← electron-vite build config (main/preload/renderer)
├── tsconfig.json             ← Root references
├── tsconfig.node.json        ← main + preload TypeScript config
└── tsconfig.web.json         ← renderer TypeScript config
```

---

## The renderer (`src/`) in depth

### `src/types/index.ts` — the source of truth

All shared types live here. When you add a new tool, adjustment type, filter, or layer variant, the type definition goes here first. Key types:

```typescript
export type Tool = 'move' | 'select' | 'brush' | 'eraser' | /* ... 20 total */

export type AdjustmentType =
  | 'brightness-contrast' | 'hue-saturation' | /* 9 more color adjustments */
  | 'bloom' | 'chromatic-aberration' | /* 5 more real-time effects */

export type FilterKey =
  | 'gaussian-blur' | 'sharpen' | /* 16 total */

export type LayerState =
  | PixelLayerState       // plain raster layer — no `type` field
  | TextLayerState        // type: 'text'
  | ShapeLayerState       // type: 'shape'
  | MaskLayerState        // type: 'mask'
  | AdjustmentLayerState  // type: 'adjustment'
  | GroupLayerState       // type: 'group'

export interface AppState {
  activeTool: Tool
  layers: LayerState[]
  activeLayerId: string | null
  selectedLayerIds: string[]
  primaryColor: RGBAColor
  secondaryColor: RGBAColor
  swatches: RGBAColor[]
  canvas: CanvasState
  openAdjustmentLayerId: string | null
  // ...
}
```

### `src/core/store/` — state management

**`AppContext.tsx`** holds global app state via `useReducer`. Adding new state:

1. Add the field to `AppState` in `src/types/index.ts`.
2. Add an action type to `AppAction`.
3. Handle it in `appReducer`.
4. `dispatch` is available everywhere via `useAppContext()`.

**Module-level singletons** are plain TypeScript classes with a subscribe/notify pattern. They hold data that needs to be read synchronously by tool handlers (which cannot call React hooks):

| Singleton | Holds |
|---|---|
| `selectionStore` | Active selection mask, pending geometry |
| `historyStore` | Undo/redo entry stack |
| `clipboardStore` | Copied pixel data |
| `adjustmentPreviewStore` | Temporary param overrides for live adjustment previews |
| `adjustmentClipboardStore` | Copied adjustment params |
| `cursorStore` | Custom cursor size/position |
| `cropStore` | Crop rectangle state |
| `transformStore` | Free-transform handles |
| `objectSelectionStore` | SAM prompt points + preview mask |
| `polygonalSelectionStore` | In-progress polygon path |

Update them imperatively: `selectionStore.clear()`. Notify React subscribers: `selectionStore.notify()`. Subscribe to them in React components: `selectionStore.subscribe(callback)` / `selectionStore.unsubscribe(callback)`.

### `src/core/services/` — all business logic

Every hook in this folder owns exactly **one cohesive concern**. They never hold UI state. They produce callbacks that `App.tsx` passes as props or handles via the menu system.

| Hook | Responsibility |
|---|---|
| `useTabs` | Multi-document management, serialization |
| `useHistory` | Capture/restore undo/redo entries |
| `useFileOps` | Open, save .verve files |
| `useExportOps` | Export PNG/JPEG/WebP/TIFF/TGA |
| `useClipboard` | Copy/cut/paste pixel data |
| `useLayers` | Layer CRUD (add, delete, reorder, rename, visibility) |
| `useLayerGroups` | Group/ungroup/merge groups |
| `useCanvasTransforms` | Resize image, resize canvas |
| `useAdjustments` | Add/open/close adjustment layers |
| `useFilters` | Dispatch filter dialogs and instant filters |
| `useTransform` | Free transform (affine/perspective) |
| `useObjectSelection` | SAM-based object selection |
| `usePolygonalSelection` | Polygonal lasso keyboard handling |
| `useContentAwareFill` | PatchMatch inpainting |
| `useKeyboardShortcuts` | Global keyboard shortcut bindings |

### `src/graphicspipeline/` — GPU rendering

**`webgpu/rendering/WebGPURenderer.ts`** is the pixel read/write interface. Everything GPU-related goes through it. Key methods:

```typescript
// Read all pixels of a layer (layer-local RGBA)
renderer.readLayerPixels(layer): Uint8Array

// Flush layer.data → GPU texture
renderer.flushLayer(layer): void

// Execute a render plan to the screen
renderer.renderPlan(plan: RenderPlanEntry[]): void

// Composite all layers into a single flat buffer
renderer.readFlattenedPixels(layers): Promise<Uint8Array>
```

**`webgpu/AdjustmentEncoder.ts`** runs the 25 adjustment compute pipelines non-destructively during compositing.

**`webgpu/compute/filterCompute.ts`** runs destructive filter compute passes (blur, sharpen, noise, etc.) when you apply a filter.

**`rasterization/`** provides the single entry point for all flatten/merge/export operations:

```typescript
rasterizeDocument({ plan, width, height, reason, renderer })
  → Promise<{ data: Uint8Array; width: number; height: number }>
```

`reason` is `'flatten' | 'export' | 'sample' | 'merge'`. **Always use this instead of writing ad-hoc compositing code.**

### `src/tools/` — drawing tools

Each tool exports a `ToolDefinition`:

```typescript
interface ToolDefinition {
  createHandler: () => ToolHandler   // factory, creates a stateful handler
  Options: React.ComponentType<...>  // options bar UI
  modifiesPixels: boolean
  paintsOntoPixelLayer?: boolean
}
```

The `ToolHandler` is a plain object — no React:

```typescript
interface ToolHandler {
  onPointerDown(pos: ToolPointerPos, ctx: ToolContext): void
  onPointerMove(pos: ToolPointerPos, ctx: ToolContext): void
  onPointerUp(pos: ToolPointerPos, ctx: ToolContext): void
}
```

All 23 tools are registered in `src/tools/index.ts` as `TOOL_REGISTRY: Record<Tool, ToolDefinition>`.

### `src/ux/` — all UI

All components are exported from `src/ux/index.ts`. Import from the barrel, not from deep paths:

```typescript
// ✅
import { GaussianBlurDialog, ModalDialog, SliderInput } from '@/ux'

// ❌ avoid
import { GaussianBlurDialog } from '@/ux/windows/filters/GaussianBlurDialog/GaussianBlurDialog'
```

Each component lives in its own folder:

```
MyComponent/
  MyComponent.tsx
  MyComponent.module.scss
```

Use `.module.scss` — plain `.scss` imports return `undefined` at runtime under Vite.

---

## Data flow summary

```
User interaction (pointer/keyboard)
  ↓
Canvas.tsx / TopBar.tsx (React event handlers)
  ↓
ToolHandler / App.tsx callback
  ↓
core/services hook (useFilters, useLayers, etc.)
  ↓
WebGPURenderer / canvasHandle / WASM
  ↓
GPU texture updated → renderPlan → screen
  ↓
captureHistory() → historyStore snapshot
  ↓
dispatch(AppAction) → AppContext reducer → React re-render
```

Layer data lives in **two places simultaneously** while a tab is active:
- **GPU** (`GpuLayer.texture`) — what is drawn on screen
- **CPU** (`GpuLayer.data`) — the `Uint8Array` that tools write pixels into before `flushLayer()`

When a tab is backgrounded, GPU data is serialized to base64 PNG strings and stored in the `TabRecord`. When restored, the PNGs are decoded back into `Uint8Array` and uploaded to the GPU.
