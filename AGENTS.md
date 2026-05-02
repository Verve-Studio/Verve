# Verve – Project Guidelines

## Overview

Desktop image editor built with Electron, React 19, TypeScript, WebGPU, and C++/WASM. Intended to be a Photoshop-grade general-purpose image editor. Despite the name, Verve is **not** a pixel art tool — it is a full-featured photo and image editor. Pixel art is a supported use case, but the application targets the full breadth of raster image editing (adjustments, filters, layer compositing, curves, color grading, etc.) that you'd expect from a professional tool like Photoshop.

## Build & Dev

```bash
npm run dev          # Start Electron + Vite in development mode
npm run build        # Production build
npm run build:wasm   # Compile C++ → WASM (requires Emscripten, run once after C++ changes)
npm run typecheck    # Type-check both main (Node) and renderer (web) processes
```

## Architecture

Verve is an Electron app split into two processes that communicate over IPC:

- **Main process** (`electron/main/`) — Node.js. Handles native file I/O, OS dialogs, IPC handlers, and ML model inference (SAM, RVM). Never imported from the renderer.
- **Preload** (`electron/preload/`) — Exposes a typed, sandboxed API to the renderer via `window.api`. This is the only bridge between the two processes.
- **Renderer** (`src/`) — React 19 app. All UI, canvas drawing, and tool logic lives here.

### Renderer structure

The renderer is organized into five top-level domains:

```
src/
  App.tsx                    ← thin orchestrator: composes hooks, renders layout
  main.tsx                   ← entry point
  core/
    io/                      ← file export helpers (exportPng, exportJpeg, exportWebp, exportTiff, exportTga, imageLoader)
    operations/
      adjustments/           ← adjustment + filter layer registry + curves data
      filters/               ← filter menu registry (menu organization only)
    services/                ← all business logic hooks (20+)
    store/                   ← AppContext, CanvasContext, module-level singletons, tabTypes
  graphicspipeline/
    rasterization/           ← unified flatten/merge/export pipeline
    webgpu/                  ← WebGPU renderer, compute pipelines, WGSL shaders
  styles/                    ← global.scss, _mixins.scss, _variables.scss
  tools/                     ← drawing tool handlers + options UIs + algorithm/
  types/                     ← shared TypeScript types (index.ts)
  utils/                     ← palette, color, layer tree, and miscellaneous utilities
  ux/                        ← all UI components
    main/                    ← layout chrome (Canvas, MenuBar, RightPanel, StatusBar, TabBar, ToolOptionsBar, Toolbar, TopBar, TransformToolbar)
      RightPanel/            ← hosts sub-panels: ColorPicker, Dock, History, Info, Layers, Navigator, Swatch
    modals/                  ← dialogs wrapping ModalDialog (AboutDialog, ColorDitheringSetupModal, ColorPickerDialog, ContentAwareFillOptionsDialog, ConvertColorModeDialog, ExportDialog, GeneratePaletteDialog, HdrLdrExportWarningDialog, KeyboardShortcutsDialog, NewImageDialog, PixelBrushesModal, ResizeCanvasDialog, ResizeImageDialog, SplashScreen)
    widgets/                 ← stateless, reusable UI components
    windows/
      adjustments/           ← one panel component per adjustment type (12)
      effects/               ← one options component per real-time effect (8)
      filters/               ← one panel component per filter layer (+ LensFlareDialog)
      HDRPanel/              ← HDR/tone-mapping settings panel
  wasm/                      ← TypeScript wrapper over C++/WASM
```

**`App.tsx` is a thin orchestrator.** It composes hooks and renders the layout — nothing more. Business logic that would otherwise live inline in `App.tsx` belongs in a dedicated hook under `src/core/services/`.

### Hooks (`src/core/services/`)

Each hook owns **one cohesive concern** and encapsulates all business logic for that domain. Hooks accept a `canvasHandleRef` and `dispatch` as inputs and never hold UI state. Examples of the expected granularity: file operations (`useFileOps`), layer manipulation (`useLayers`), undo/redo history (`useHistory`), canvas dimension transforms (`useCanvasTransforms`). If a hook is doing two clearly unrelated jobs, split it.

### Components (`src/ux/`)

Components are divided into four categories. Choosing the right category is important — it defines what the component is allowed to know about.

| Category | Path | What it can access |
|---|---|---|
| **Widgets** | `ux/widgets/` | UX widgets. Stateless, reusable anywhere. No app state. |
| **Main UX Framework** | `ux/main/`  | The core overall UX layout |
| **Floating Window Panels** | `ux/windows/` | Windows for adjustment layers, effects, etc |
| **Modals** | `ux/modals/` | Wraps `ModalDialog`. Dialogs that are blocking the main UX |

**The key rule:** a widget must never reach into `AppContext`, and a layout (main) component must never duplicate logic that belongs in a panel. For example, `RightPanel` (`ux/main/`) hosts `ColorPicker` and `LayerPanel` — it renders them, not their contents.

**Folder conventions:** one component per folder with a PascalCase name. Each folder contains exactly `ComponentName.tsx` and `ComponentName.module.scss`. All components are exported from `src/ux/index.ts`. Always check existing components before building new UI.

### Tools (`src/tools/`)

Each tool exports two things:
1. A **handler factory** (e.g. `createBrushHandler()`) — a plain object with pointer event callbacks, no React.
2. A **React options UI component** — rendered in the tool options bar.

Drawing options (size, opacity, hardness, etc.) are stored in a **module-level options object** (e.g. `export const brushOptions = { size: 10, ... }`). This is intentional: pointer event handlers run synchronously and cannot read React state. The options object is also exported so `Canvas.tsx` can read the current brush size for cursor rendering without coupling to React state.

Every handler factory receives a **`ToolContext`** on each pointer event:
- `ctx.renderer` — the `WebGPURenderer` instance
- `ctx.layer` — the active `GpuLayer` (layer-local pixel data + offset)
- `ctx.layers` — all `GpuLayer` objects
- `ctx.primaryColor`, `ctx.secondaryColor`, `ctx.zoom`, `ctx.selectionMask`, etc.

**Coordinate spaces:** `GpuLayer.data` is in **layer-local** space. The stride depends on `layer.format` (see Pixel Formats below). Canvas-space operations (e.g. `selectionStore.floodFillSelect`) require a canvas-sized buffer. When sampling only the active layer at canvas-space coordinates, scatter `layer.data` into a canvas-sized buffer offset by `layer.offsetX, layer.offsetY`.

### State

Global app state (active tool, colors, layers, swatches, selectedLayerIds) flows through `AppContext` via `useReducer`. The pattern for adding new state:
1. Add the new field to `AppState` in `src/types/index.ts`.
2. Add the reducer action to `src/core/store/AppContext.tsx`.
3. Export `AppAction` so hooks outside `AppContext.tsx` can dispatch.

Tab state (multi-document) lives in `useTabs`. Canvas pixel data lives in WebGPU while a tab is active and is serialized to `savedLayerData` only when the tab is backgrounded. Operations that change the canvas dimensions (resize, crop) must increment `canvasKey` on the tab record to force a Canvas remount with the new size.

Avoid re-initializing canvas layers in effects that list `rendererRef.current` as a dependency — use a `hasInitializedRef` guard instead.

**Module-level singletons** (`src/core/store/`): stateful objects that tools and canvas components import directly without going through React. These include `selectionStore` (selection mask + pending geometry), `historyStore`, `clipboardStore`, `adjustmentClipboardStore`, `adjustmentPreviewStore`, `cursorStore`, `cropStore`, `transformStore`, `objectSelectionStore`, `polygonalSelectionStore`, `cloneStampStore`, `pixelBrushStore`, and `displayStore`. They are not React state; update them imperatively and call their `notify()` method to trigger subscribers.

**`selectedLayerIds`** is kept in `AppState` (not as local panel state) so that hooks like `useLayers` can act on multi-layer selections. Any action that resets the layer stack (`SET_ACTIVE_LAYER`, `REORDER_LAYERS`, `RESTORE_LAYERS`, `NEW_CANVAS`, `OPEN_FILE`, `RESTORE_TAB`, `SWITCH_TAB`) also resets `selectedLayerIds` to `[]`.

### Pixel Formats

Every layer and every document has a `PixelFormat`:

| Value | `layer.data` type | Bytes/pixel | Notes |
|---|---|---|---|
| `'rgba8'` | `Uint8Array` | 4 | Standard 8-bit RGBA (0–255 per channel) |
| `'rgba32f'` | `Float32Array` | 16 | 32-bit float RGBA (0.0–1.0 per channel) |
| `'indexed8'` | `Uint8Array` | 1 | Palette indices (0–254); 255 = transparent sentinel |

`PixelFormat` is defined in `src/types/index.ts`. `AppState.pixelFormat` holds the document-level format and is set by the `SET_PIXEL_FORMAT`, `NEW_CANVAS`, `OPEN_FILE`, `RESTORE_TAB`, and `SWITCH_TAB` actions. `TabRecord.pixelFormat` mirrors it and is kept in sync by a `useEffect` in `App.tsx`.

**Key format rules for tool authors:**
- `blendPixelOver` (`src/tools/algorithm/primitives.ts`) always receives `r/g/b/a` as **0–255** from callers, regardless of format. It normalizes internally for `rgba32f`.
- `renderer.samplePixel(layer, lx, ly)` returns `[r, g, b, a]` where values are 0–255 for `rgba8`, 0.0–1.0 for `rgba32f`, and `[index, 0, 0, 255]` for `indexed8`.
- `renderer.drawPixel(layer, lx, ly, r, g, b, a)` expects values in the layer's native range (0–255 or 0.0–1.0).
- `renderer.flushLayer(layer, palette?)` — must pass `palette` (the current `state.swatches`) when `layer.format === 'indexed8'`; it expands indices to RGBA for GPU upload.
- Any code that reads `layer.data[i+3] / 255` or writes `Math.round(outA * 255)` directly is broken for `rgba32f`. Any code that reads/writes 4 bytes per pixel is broken for `indexed8`.
- `readLayerPixels(layer)` and `readFlattenedPixels(layers)` return `Float32Array` for `rgba32f` layers — never type-assert the result as `Uint8Array`.

**Tab serialization:** `serializeActiveTabPixels` and the history-jump path encode indexed8 layers as `data:raw/indexed8;base64,…` and rgba32f layers via `f32TransferStore`. The history store (`historyStore.ts`) holds `layerPixels: Map<string, Uint8Array | Float32Array>`.

**New Image dialog:** the Color Mode selector lets users pick `rgba8`, `rgba32f`, or `indexed8` when creating a new document.

**Tab bar and status bar** both show the active document's pixel format.

---

### WebGPU (`src/graphicspipeline/webgpu/`)

`rendering/WebGPURenderer.ts` is the GPU pixel read/write layer. `AdjustmentEncoder.ts` owns the compute pipelines for color adjustments and real-time effects. `compute/filterCompute.ts` owns the compute pipelines for filter layers (gaussian/box/radial/motion/lens blur, sharpen variants, noise, median, bilateral, reduce-noise, clouds, pixelate, etc.) and is dispatched non-destructively from the render plan. It operates on `GpuLayer` objects:

```ts
interface GpuLayer {
  id: string
  name: string
  texture: GPUTexture
  data: Uint8Array | Float32Array  // format-dependent (see Pixel Formats above)
  format: PixelFormat
  layerWidth: number
  layerHeight: number
  offsetX: number         // position of layer top-left on the canvas
  offsetY: number
  opacity: number
  visible: boolean
  blendMode: string
  dirtyRect: { lx: number; ly: number; rx: number; ry: number } | null
  contentVersion: number  // incremented by flushLayer; used by render cache
}
```

Key methods used by tools and layer operations:
- `readLayerPixels(layer)` → `Uint8Array | Float32Array` in **layer-local** space
- `readFlattenedPixels(layers)` → async, canvas-sized composite buffer
- `flushLayer(layer, palette?)` — uploads `layer.data` to GPU texture; pass `palette` for `indexed8`
- `growLayerToFit(layer, canvasX, canvasY, extraRadius?)` — expands layer buffer; correctly allocates `Float32Array` for `rgba32f` and 1-byte `Uint8Array` for `indexed8`

Do not bypass `WebGPURenderer` to manipulate pixel data directly.

### Shader file layout

WGSL source lives in standalone `.wgsl` files imported with Vite's `?raw` loader. Each shader category has a `wgsl/` subdirectory next to its `.ts` re-export wrappers:

```
shaders/
  rendering/
    blit.ts / checker.ts / composite.ts   ← ?raw re-export wrappers
    wgsl/
      blit.wgsl, hdr-blit.wgsl, checker.wgsl, composite.wgsl
  compute/
    adjustments/
      bloom.ts, brightness-contrast.ts, …  ← ?raw re-export wrappers
      wgsl/
        bloom-extract.wgsl, bloom-blur-h.wgsl, bc.wgsl, …
    filters/
      gaussian-blur.ts, sharpen.ts, …
      wgsl/
        filter-gaussian-h.wgsl, filter-sharpen.wgsl, …
    grabcut/
      dataterms.ts, nlinks.ts
      wgsl/
        filter-grabcut-dataterms.wgsl, filter-grabcut-nlinks.wgsl
```

The `.ts` wrapper for each shader is minimal:
```ts
import FOO_COMPUTE from './wgsl/foo.wgsl?raw'
export { FOO_COMPUTE }
```

When adding a new shader: write the `.wgsl` file in the appropriate `wgsl/` subdirectory, then add a corresponding `?raw` import + re-export in the `.ts` wrapper file. Do not embed WGSL as a TypeScript string.

Adjustment shaders are compiled and registered inside `AdjustmentEncoder.ts`. Filter shaders are compiled inside `filterCompute.ts`.

The render plan for the on-screen preview is built in `src/ux/main/Canvas/canvasPlan.ts` and consumed by `WebGPURenderer`.

Layer compositing for flatten/merge/export is centralized in the unified rasterization pipeline (`src/graphicspipeline/rasterization/`) and executed from a shared render plan. Do not add separate compositing implementations for these operations.

### Adjustment Layers

Adjustment layers are non-destructive pixel operations inserted into the layer stack. They are backed by WGSL compute shaders and rendered in real time.

**Registry** (`src/core/operations/adjustments/registry.ts`): every adjustment type is registered with a `label`, `defaultParams`, and a `group`:
- `'color-adjustments'` — shown in the **Adjustments** top menu (12 types)
- `'real-time-effects'` — shown in the **Effects** top menu (8 types: bloom, chromatic-aberration, halation, color-key, drop-shadow, glow, outline, halftone) — panels live in `src/ux/windows/effects/`
- `'filters'` — shown in the **Filters** top menu (gaussian-blur, box-blur, radial-blur, motion-blur, remove-motion-blur, lens-blur, sharpen, sharpen-more, unsharp-mask, smart-sharpen, add-noise, film-grain, median-filter, bilateral-filter, reduce-noise, clouds, pixelate). These run through `compute/filterCompute.ts` rather than `AdjustmentEncoder.ts`.

**Adding a new adjustment / effect type:**
1. Add the `AdjustmentType` literal and its `AdjustmentParamsMap` entry in `src/types/index.ts`.
2. Register it in `src/core/operations/adjustments/registry.ts` with label, defaults, and group (`'color-adjustments'` or `'real-time-effects'`).
3. Write the WGSL shader as `src/graphicspipeline/webgpu/shaders/compute/adjustments/wgsl/<name>.wgsl`, add a `?raw` re-export in the corresponding `.ts` wrapper, then register it in `AdjustmentEncoder.ts`.
4. Add the `AdjustmentRenderOp` variant + uniform dispatch in `AdjustmentEncoder.ts`.
5. Add the render-plan mapping in `src/ux/main/Canvas/canvasPlan.ts`.
6. Create a panel component in `src/ux/windows/adjustments/<TypeName>Panel/` or `src/ux/windows/effects/<TypeName>Options/`.
7. Ensure unified rasterization includes it for flatten/export/merge.

The WGSL uniform struct must match the `Float32Array` passed from `AdjustmentEncoder.ts` **exactly** (byte offsets, padding, total size).

### Filters

Filters are **non-destructive** layers, just like adjustment and effect layers. Choosing a filter from the **Filters** top menu inserts a new filter layer into the layer stack; its parameters can be edited live via its panel and re-rendered every frame from the render plan.

- The **execution path** for filter layers is `compute/filterCompute.ts` (separate from `AdjustmentEncoder.ts`), which owns all filter compute pipelines and intermediate textures.
- Filter layers are registered in `ADJUSTMENT_REGISTRY` with `group: 'filters'` — they share the `AdjustmentLayer` machinery (params, history, rasterization) with regular adjustments.
- `src/core/operations/filters/registry.ts` (`FILTER_REGISTRY` / `FilterKey`) is now used **only** for organizing the Filters top menu into submenus (`blur`, `sharpen`, `noise`, `render`, `pixelate`) and for the rare dialog-based filter (Lens Flare, which still produces a new pixel layer via `useFilters.handleApplyLensFlare`).
- `useFilters` is a thin shim: each `handleOpen…` calls `onCreateFilterAdjLayer(<adjustmentType>)` to insert the corresponding filter adjustment layer.

**Adding a new filter:**
1. Add the new `AdjustmentType` literal and its `AdjustmentParamsMap` entry in `src/types/index.ts` (and the `*AdjustmentLayer` interface + union).
2. Register it in `src/core/operations/adjustments/registry.ts` with `group: 'filters'` and default params.
3. Add the corresponding `FilterKey` entry to `src/core/operations/filters/registry.ts` so it appears in the Filters top menu under the right submenu.
4. Write the WGSL compute shader as `src/graphicspipeline/webgpu/shaders/compute/filters/wgsl/<name>.wgsl`, add a `?raw` re-export in the `.ts` wrapper, then wire it into `compute/filterCompute.ts` (pipeline construction + `runX` dispatch + `pendingDestroy*` cleanup).
5. Add the render-plan mapping in `src/ux/main/Canvas/canvasPlan.ts` (one branch per `adjustmentType`).
6. Create a panel component in `src/ux/windows/filters/<Name>Panel/` (use `filterPanel.module.scss` for styling).
7. Wire the menu handler in `useFilters` (e.g. `handleOpenFoo = () => onCreateFilterAdjLayer('foo')`).
8. Ensure unified rasterization handles it for flatten/export/merge.

### Unified Rasterization Pipeline

- Flatten, merge, and export must all run through the same centralized rasterization pipeline (`src/graphicspipeline/rasterization/`). Do not add ad-hoc compositing paths for one operation.
- The pipeline only supports `RasterBackend = 'gpu'`. There is no CPU fallback.
- `rasterizeDocument({ plan, width, height, reason, renderer })` is the single entry point. `reason` is one of `'flatten' | 'export' | 'sample' | 'merge'`.
- Temporary preview-bypass state must never leak into final flatten/export/merge outputs.
- If flatten/export/merge execution fails, surface the error to the user. Never silently no-op.

Maintenance checklist for new adjustment/filter types:
1. Add the new adjustment/filter to the registry and related types.
2. Add its render-plan entry mapping.
3. Add its WebGPU pass/shader path.
4. Ensure unified rasterization includes it for flatten/export/merge.
5. Add or update parity tests across screen preview, flatten, and export outputs.

CPU fallback policy:
- If CPU fallback is introduced or re-enabled, parity-validate it against the GPU path before activation.
- CPU fallback must not silently degrade output quality or compositing correctness.

### Drawing / Pixel Operations

- All pixel blending uses **Porter-Duff "over" compositing** via `blendPixelOver` in `src/tools/algorithm/primitives.ts`.
- `blendPixelOver` callers always pass `r/g/b/a` as **0–255**. The function branches on `layer.format` to normalize and write in the correct native range.
- Track per-stroke coverage with a `Map<number, number>` (key = packed pixel index, value = max effective alpha applied) to prevent opacity accumulation within a single stroke.
- Thick brush shapes: **circle stamp** for hard edges; **capsule SDF** for anti-aliased thick lines. Both helpers live in `src/tools/algorithm/bresenham.ts`.
- When adding a new drawing operation, always branch on `layer.format` for `rgba32f` (float math, no rounding) and `indexed8` (palette-index write, no alpha blending). Do not assume `rgba8`.

## Conventions

### CSS Modules

Always use `.module.scss`. Vite treats plain `.scss` default imports as `undefined` at runtime, causing silent failures.

```ts
import styles from './MyComponent.module.scss'
// use as: styles.myClass
```

### IPC

Main → Renderer communication goes through `electron/main/ipc.ts` and the typed preload at `electron/preload/index.ts`. In the renderer, use `window.api.*`. Never import Electron modules directly in `src/`.

### Top Menu

Menu order: **File → Edit → Select → Layer → Adjustments → Effects → Filters → View → Help**

- **Select** menu: Invert Selection (`Ctrl+Shift+I`)
- **Adjustments** menu: all `ADJUSTMENT_REGISTRY` entries with `group: 'color-adjustments'`
- **Effects** menu: all `ADJUSTMENT_REGISTRY` entries with `group: 'real-time-effects'` (bloom, chromatic-aberration, halation, color-key, drop-shadow, glow, outline, halftone)
- **Layer** menu: New Layer, Duplicate Layer, Delete Layer | Rasterize Layer | Group Layers, Ungroup Layers | Merge Selected, Merge Down, Merge Visible, Flatten Image

### Pointer / Tablet Input

All pointer events flow through `useCanvas` → `Canvas.tsx` → `ToolHandler`. Never attach raw DOM mouse/touch listeners in tools.

A few non-obvious rules for correct tablet and high-frequency mouse behavior:
- Replay coalesced events (`getCoalescedEvents`) for `pen`/`touch` only — high-polling mice (1000 Hz) generate 16+ coalesced events per frame and will tank performance.
- Use `e.button !== 0` guards on `pointerdown`/`pointerup` to ignore barrel-button and eraser-end events from Wacom tablets.
- Detect silent pen-lift (tip lifts without `pointerup`) by checking `!(e.buttons & 1)` on `pointermove`.
- Pass `e.timeStamp` (not `performance.now()`) through `ToolPointerPos` so velocity-tracking tools get accurate timing from coalesced hardware timestamps.
- For velocity-aware tools, use the **outer event's** `e.pressure` for all coalesced samples — per-coalesced pressure fluctuates at hardware polling rate and causes jitter.

### Canvas Cursor

For tools with a custom cursor (brush, eraser), hide the native cursor (`cursor: none`) and drive a CSS circle div imperatively via a ref on every `onHover` call. Use `white border + dark box-shadow` for visibility on both light and dark canvases. Never update cursor appearance through React state — it would cause unnecessary re-renders on every pointer move.

## WASM / C++ Layer

CPU-intensive operations (flood fill, blur, resize, dithering, quantization, inpainting, segmentation, transforms) are implemented in C++17 under `wasm/src/` and compiled to WASM via Emscripten. The TypeScript side of this boundary is `src/wasm/index.ts`, which exposes a clean async API. Never import from `src/wasm/generated/` directly.

### Adding a new operation
1. Implement in a new `.h`/`.cpp` under `wasm/src/`.
2. Add an `extern "C" EMSCRIPTEN_KEEPALIVE` wrapper in `wasm/src/pixelops.cpp`.
3. Append the symbol name (with leading `_`) to `-sEXPORTED_FUNCTIONS` in `wasm/CMakeLists.txt`.
4. Add the TypeScript signature to `src/wasm/types.ts` and a high-level wrapper to `src/wasm/index.ts`.
5. Run `npm run build:wasm`.

### Memory rules
- All WASM buffers are managed via `_malloc`/`_free` — the wrapper handles this automatically.
- Re-read `module.HEAPU8` **after** any WASM call (memory may have been grown); the wrapper's `withInPlaceBuffer` does this correctly.
- `src/wasm/generated/` is gitignored — run `build:wasm` on a fresh clone.

### Setting up Emscripten (first time)
```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh   # re-run in each new terminal

# Back in Verve:
npm run build:wasm
```
