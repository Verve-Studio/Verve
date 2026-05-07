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

```
src/
  App.tsx                    ← thin orchestrator: composes hooks, renders layout
  main.tsx                   ← entry point
  core/
    effects/                 ← all adjustments, real-time effects, filters (one folder per effect)
      _shared/               ← cross-effect UI helpers (distortionShared, filterPanel.module.scss)
      Bloom/                 ← BloomEffect.tsx, BloomOptions.tsx + .scss, bloom-*.wgsl
      GaussianBlur/          ← GaussianBlurEffect.tsx, GaussianBlurPanel.tsx, filter-gaussian-{h,v}.wgsl
      …                      ← (50+ folders, one per effect)
      IPipelineEffect.ts     ← interface every effect implements
      effectRegistry.ts      ← runtime registry, populated by side-effect imports
      shaderLoader.ts        ← import.meta.glob discovery of every *.wgsl under core/effects
      index.ts               ← imports + registers each effect (the single registration point)
    io/                      ← file export helpers (exportPng, exportJpeg, exportWebp, exportTiff, exportTga, imageLoader)
    operations/
      adjustments/           ← Curves data tables (curves.ts, curvesPresets.ts) only
    services/                ← all business logic hooks (20+)
    store/                   ← AppContext, CanvasContext, module-level singletons, tabTypes
  graphics/
    rasterization/           ← unified flatten/merge/export pipeline
    webgpu/
      AdjustmentEncoder.ts   ← thin dispatcher (~80 lines): looks up effect by id, calls effect.encode()
      EffectRuntime.ts       ← shared GPU primitives for every effect (cached pipelines, samplers, scratch tex, render-pass helpers)
      compute/
        grabcutCompute.ts
      rendering/             ← WebGPURenderer + pipeline factories
      shaders/
        rendering/           ← only rendering shaders live here (composite, checker, blit)
        compute/grabcut/     ← grabcut compute shaders
  styles/                    ← global.scss, _mixins.scss, _variables.scss
  tools/                     ← drawing tool handlers + options UIs + algorithm/
  types/                     ← shared TypeScript types (index.ts)
  utils/                     ← palette, color, layer tree, and miscellaneous utilities
  ux/                        ← UI components
    main/                    ← layout chrome (Canvas, MenuBar, RightPanel, StatusBar, TabBar, ToolOptionsBar, Toolbar, TopBar, TransformToolbar)
      RightPanel/            ← hosts sub-panels: ColorPicker, Dock, HDRPanel, History, Info, Layers, Navigator, Swatch
    modals/                  ← dialogs wrapping ModalDialog
    widgets/                 ← stateless, reusable UI components
    windows/                 ← the floating ToolWindow chrome + brush options panels
  wasm/                      ← TypeScript wrapper over C++/WASM
```

**`App.tsx` is a thin orchestrator.** It composes hooks and renders the layout — nothing more. Business logic that would otherwise live inline in `App.tsx` belongs in a dedicated hook under `src/core/services/`.

### Hooks (`src/core/services/`)

Each hook owns **one cohesive concern** and encapsulates all business logic for that domain. Hooks accept a `canvasHandleRef` and `dispatch` as inputs and never hold UI state. Examples of the expected granularity: file operations (`useFileOps`), layer manipulation (`useLayers`), undo/redo history (`useHistory`), canvas dimension transforms (`useCanvasTransforms`). If a hook is doing two clearly unrelated jobs, split it.

### Components (`src/ux/`)

| Category | Path | What it can access |
|---|---|---|
| **Widgets** | `ux/widgets/` | Stateless, reusable anywhere. No app state. |
| **Main UX Framework** | `ux/main/` | Top-level layout chrome. |
| **Floating window chrome** | `ux/windows/` | Generic `ToolWindow` wrapper + tool-specific options (brush). Effect/adjustment/filter panels do **not** live here — they're co-located with their effect under `src/core/effects/{Name}/`. |
| **Modals** | `ux/modals/` | Wraps `ModalDialog`. Dialogs that block the main UX. |

**The key rule:** a widget must never reach into `AppContext`, and a layout (main) component must never duplicate logic that belongs in a panel. For example, `RightPanel` (`ux/main/`) hosts `ColorPicker` and `LayerPanel` — it renders them, not their contents.

**Folder conventions:** one component per folder with a PascalCase name. Each folder contains exactly `ComponentName.tsx` and `ComponentName.module.scss`. Non-effect UX components are exported from `src/ux/index.ts`. Always check existing components before building new UI.

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

### WebGPU (`src/graphics/webgpu/`)

`rendering/WebGPURenderer.ts` is the GPU pixel read/write layer. It operates on `GpuLayer` objects:

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

The render plan for the on-screen preview is built in `src/ux/main/Canvas/canvasPlan.ts` and consumed by `WebGPURenderer`. Layer compositing for flatten/merge/export goes through the unified rasterization pipeline (`src/graphics/rasterization/`). Do not add separate compositing implementations for these operations.

---

## Effects, adjustments, filters

All adjustments, real-time effects, and filters share one architecture and one folder tree under `src/core/effects/`. The terms "adjustment", "effect", and "filter" only differ in which top menu they appear under (`adjustments` / `effects` / `filters`); the runtime treats them uniformly as **pipeline effects** — non-destructive layers inserted into the layer stack and re-rendered every frame from the render plan.

### Per-effect folder

Every effect lives in its own folder `src/core/effects/{PascalName}/` containing:

- **`{Name}Effect.tsx`** — implements `IPipelineEffect`. Owns the effect's id, label, menu placement, default params, plan-entry builder, encode body, and panel reference. Optional `onFrameEnd?()` / `onDestroy?()` lifecycle hooks for effects that hold cross-frame texture caches.
- **`{Name}Panel.tsx`** (or `{Name}Options.tsx`) **+ `.module.scss`** — the right-side panel UI rendered when the layer is selected.
- **`*.wgsl`** — every WGSL shader the effect needs, sitting next to the class.

Cross-effect helpers (`distortionShared.tsx`, `distortionPanel.module.scss`, `filterPanel.module.scss`) live in `src/core/effects/_shared/`.

### `IPipelineEffect` interface

Defined in `src/core/effects/IPipelineEffect.ts`:

```ts
interface IPipelineEffect<L extends AdjustmentLayerState, Op extends AdjustmentRenderOp> {
  readonly id: L["adjustmentType"] & Op["kind"];   // stable id; routes layer/op union members to this effect
  readonly label: string;
  readonly menu: { root: "adjustments" | "effects" | "filters"; submenu?: string; instant?: boolean; shortcut?: string };
  readonly defaultParams: L["params"];

  buildPlanEntry(layer: L, ctx: PlanContext): Op;          // called every frame
  encode(ctx: EncodeContext, entry: Op): void;             // records GPU work into the command encoder

  readonly Panel: ComponentType<PanelProps<L>>;            // right-panel component

  onFrameEnd?(): void;                                     // optional: evict cross-frame caches
  onDestroy?(): void;                                      // optional: tear down persistent GPU resources
}
```

`EncodeContext` carries `{ encoder, srcTex, dstTex, format, engine }`. `engine` is the `AdjustmentEncoder` instance, which exposes `engine.runtime` (`EffectRuntime`) for shared GPU primitives.

### Registry & dynamic discovery

`src/core/effects/effectRegistry.ts` is a tiny `Map<string, IPipelineEffect>`. Registration is **eager** and happens via side-effect imports in `src/core/effects/index.ts`. Importing `@/core/effects` is the single load-bearing step that makes every effect reachable from the plan builder, encoder, and panel host.

```ts
// src/core/effects/index.ts
import { BloomEffect } from "./Bloom/BloomEffect";
…
effectRegistry.register(BloomEffect);
…
```

Shaders are auto-discovered by `src/core/effects/shaderLoader.ts`, which uses `import.meta.glob('./**/*.wgsl', { query: '?raw', eager: true })` to build a name→source map. Consumers (`EffectRuntime`, individual effects) call `getShader("filter-gaussian-h")` to fetch by basename. There is no hand-maintained barrel; dropping a `.wgsl` file inside any effect folder makes it discoverable.

### Runtime services

Effects don't construct their own pipelines. One shared **`EffectRuntime`** (`src/graphics/webgpu/EffectRuntime.ts`) provides the cached pipeline / sampler / scratch-texture / render-pass primitives that every effect (adjustment, real-time effect, and filter) uses. Effects access it via `engine.runtime` from their `encode` body. It exposes `getRenderPipelinePair(shaderName, entryPoint, bindings?)`, `getRenderPipelineSingle(shaderName, entryPoint, format, bindings?)`, `getRenderPipelineWithBGL(...)`, `getRenderPipelineAuto(...)`, `getComputePipeline(...)`, `encodeStdAdjRenderPass(...)`, `encodeRenderPass(...)`, samplers (`adjSampler`, `lutSampler`), the shared `intermediate` scratch texture, transient `makeRgba8Tex` / `makeRgba16FloatTex` allocators, params/maskFlags buffer helpers, and pending-destroy tracking. All pipelines are lazily cached by key, so two effects that share a shader share the compiled `GPUShaderModule` and pipeline.

`AdjustmentEncoder` is the dispatcher that owns the single `EffectRuntime` instance. Its `flushPendingDestroys()` releases the runtime's pending buffers and textures after `device.queue.submit()`. Cross-frame texture caches (e.g. Bloom's downsampled glow buffers) are owned by the effect itself as module-level state and evicted via `onFrameEnd`.

### `AdjustmentEncoder` — thin dispatcher

`AdjustmentEncoder` is ~80 lines. Its `encode(encoder, entry, srcTex, dstTex, format)` looks up the effect by `entry.kind` in the registry and calls `effect.encode({ encoder, srcTex, dstTex, format, engine: this }, entry)`. It also iterates the registry on `endFrame()` and `destroy()` to invoke `onFrameEnd`/`onDestroy` hooks.

### Adding a new effect / adjustment / filter

It's a single-folder operation:

1. Create `src/core/effects/{PascalName}/`.
2. Add the `AdjustmentType` literal and `AdjustmentParamsMap` entry in `src/types/index.ts` (and the `*AdjustmentLayer` interface + union).
3. Write the `.wgsl` shader(s) directly in the folder. No separate `.ts` re-export wrapper is needed — `shaderLoader` discovers them automatically by basename.
4. Add a render-plan op variant (if any new fields) in the relevant `AdjustmentRenderOp` union, and the render-plan mapping in `src/ux/main/Canvas/canvasPlan.ts` (typically a one-line case that forwards `entry`).
5. Write `{Name}Effect.tsx` implementing `IPipelineEffect` — its `encode` body uses `engine.runtime.getRenderPipelinePair(...)` directly. Mirror the pattern of the closest existing effect (e.g. for a standard color adjustment, copy `BrightnessContrast/BrightnessContrastEffect.tsx`).
6. Write `{Name}Panel.tsx` + `.module.scss` for the right-panel UI.
7. Register the effect in `src/core/effects/index.ts` (one import line + one `effectRegistry.register(...)` line). This is the only edit outside the new folder.
8. Ensure unified rasterization handles it for flatten/export/merge — most cases just work because the rasterizer goes through the same encoder.

The WGSL uniform struct must match the `Float32Array`/`Uint32Array` packed inside the effect's `encode` exactly (byte offsets, padding, total size).

### Unified Rasterization Pipeline

- Flatten, merge, and export all run through `src/graphics/rasterization/`. Do not add ad-hoc compositing paths for one operation.
- The pipeline only supports `RasterBackend = 'gpu'`. There is no CPU fallback.
- `rasterizeDocument({ plan, width, height, reason, renderer })` is the single entry point. `reason` is one of `'flatten' | 'export' | 'sample' | 'merge'`.
- Temporary preview-bypass state must never leak into final flatten/export/merge outputs.
- If flatten/export/merge execution fails, surface the error to the user. Never silently no-op.

CPU fallback policy:
- If CPU fallback is ever introduced, parity-validate it against the GPU path before activation.
- CPU fallback must not silently degrade output quality or compositing correctness.

### Drawing / Pixel Operations

- All pixel blending uses **Porter-Duff "over" compositing** via `blendPixelOver` in `src/tools/algorithm/primitives.ts`.
- `blendPixelOver` callers pass `r/g/b/a` as **0–255** for `rgba8`/`indexed8` layers. For `rgba32f` layers, callers may instead pass a `srcFloat: readonly [number, number, number, number]` in native `[0,1]` (or `>1` for HDR) to bypass the `÷255` normalisation and preserve full float precision. HDR paint intensity is still applied to RGB internally in both paths. The clone stamp always uses `srcFloat` when the source buffer is a `Float32Array`.
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
- **Adjustments / Effects / Filters** menus: built dynamically from `effectRegistry.byMenuRoot(...)` — every entry under the matching `menu.root` shows up automatically.
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
