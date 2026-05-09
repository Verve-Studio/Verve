# Verve – Project Guidelines

## Overview

Verve is a desktop image editor built with Electron, React 19, TypeScript, WebGPU, and C++/WASM. It is a Photoshop-grade general-purpose image editor — not a pixel-art tool. Pixel art is a supported use case, but the application targets the full breadth of raster image editing (adjustments, filters, layer compositing, curves, color grading, tonal brushes, distortion, etc.) you'd expect from a professional tool like Photoshop.

## Build & Dev

```bash
npm run dev          # Start Electron + Vite in development mode
npm run build        # Production build
npm run build:wasm   # Compile C++ → WASM (run once after C++ changes)
npm run typecheck    # Type-check both main (Node) and renderer (web) processes
```

## Architecture

Verve is an Electron app split into two processes that communicate over IPC:

- **Main process** (`electron/main/`) — Node.js. Native file I/O, OS dialogs, IPC handlers, ML model inference (SAM, RVM). Never imported from the renderer.
- **Preload** (`electron/preload/`) — Exposes a typed, sandboxed API to the renderer via `window.api`. The only bridge between processes.
- **Renderer** (`src/`) — React 19 app. All UI, canvas drawing, and tool logic lives here.

### Renderer structure

```
src/
  App.tsx                    ← thin orchestrator: composes hooks, renders layout
  main.tsx                   ← entry point
  core/
    tools/                   ← every tool lives here (one folder per tool)
      _shared/               ← cross-tool helpers
        ITool.ts             ← the tool interface + ToolGroup enum + placement type
        SvgIcon.tsx          ← SVG raw-string → React component helper
        types.ts             ← ToolHandler, ToolContext, ToolPointerPos, ToolOptionsStyles
        primitives.ts        ← blendPixelOver, bresenham, wuLine, SelMask
        localBrush.ts        ← shared brush iteration (Blur/Sharpen/Smudge/Heal/QuickSelect)
        resizeCursor.ts      ← shared resize-handle cursor mapping (Frame/Shape/Transform)
        sdf.ts               ← SDF computation for brush tip bitmaps
      Pencil/                ← Pencil.tsx, brushStroke.ts, pencil.svg
      Brush/                 ← Brush.tsx, stampEngine.ts, tipSampler.ts,
                               colorJitter.ts, paperTexture.ts, dynamicsResolver.ts,
                               brushPreset.ts (Brush data model), brush.svg
      Eraser/                ← Eraser.tsx, eraseStroke.ts, eraser.svg
      CloneStamp/            ← CloneStamp.tsx, cloneStampStroke.ts, clone-stamp.svg
      Dodge/                 ← Dodge.tsx (defines dodge + burn), dodgeBurn.ts,
                               dodge.svg, burn.svg
      Blur/, Sharpen/, Smudge/, HealingBrush/, QuickSelect/, Patch/,
      Frame/, Shape/, Crop/, Eyedropper/, Fill/, Gradient/,
      Hand/, Lasso/, Liquify/, MagicWand/, Measure/, Move/, Noop/,
      ObjectSelection/, Pick/, PolygonalSelection/, Select/, Text/,
      Transform/, Zoom/
      toolRegistry.ts        ← register / get / toolbarGroups / resolveShortcutCycle
      index.ts               ← imports each tool file (side-effect registration);
                               re-exports TOOL_REGISTRY for legacy callsites
    effects/                 ← all adjustments, real-time effects, filters (one folder per effect)
      _shared/               ← cross-effect UI helpers
      Bloom/                 ← BloomEffect.tsx, BloomOptions.tsx + .scss, *.wgsl
      GaussianBlur/          ← GaussianBlurEffect.tsx, GaussianBlurPanel.tsx, *.wgsl
      …                      ← (50+ folders, one per effect)
      IPipelineEffect.ts     ← interface every effect implements
      effectRegistry.ts      ← runtime registry, populated by side-effect imports
      shaderLoader.ts        ← import.meta.glob discovery of every *.wgsl
      index.ts               ← imports + registers each effect
    io/                      ← file export helpers (exportPng, exportJpeg, exportWebp,
                               exportTiff, exportTga, encodeAnimatedGif, imageLoader)
    services/                ← all business logic hooks (32 of them)
    store/                   ← AppContext, CanvasContext, module-level singletons, tabTypes
  graphics/
    rasterization/           ← unified flatten / merge / export pipeline
    webgpu/
      EffectEncoder.ts       ← thin dispatcher (~80 lines): looks up effect by id, calls effect.encode()
      EffectRuntime.ts       ← shared GPU primitives (cached pipelines, samplers, scratch tex, render-pass helpers)
      compute/grabcutCompute.ts
      rendering/             ← WebGPURenderer + pipeline factories
      shaders/
        rendering/           ← rendering shaders (composite, checker, blit)
        compute/grabcut/     ← grabcut compute shaders
  styles/                    ← global.scss, _mixins.scss, _variables.scss
  types/                     ← shared TypeScript types (index.ts)
  utils/                     ← palette, color, layer tree, and miscellaneous utilities
  ux/                        ← UI components
    main/                    ← layout chrome (Canvas, MenuBar, RightPanel, StatusBar,
                               TabBar, ToolOptionsBar, Toolbar, TopBar, TransformToolbar,
                               AnimationPanel, PlaybackBar)
      RightPanel/            ← hosts sub-panels: ColorPicker, Dock, HDRPanel, History,
                               Info, Layers, Navigator, Swatch
    modals/                  ← dialogs wrapping ModalDialog
    widgets/                 ← stateless, reusable UI components
    windows/                 ← floating ToolWindow chrome + brush options panels
  wasm/                      ← TypeScript wrapper over C++/WASM
```

**`App.tsx` is a thin orchestrator.** It composes hooks and renders the layout — nothing more. Business logic that would otherwise live inline in `App.tsx` belongs in a dedicated hook under `src/core/services/`.

### Avoid scattering tool code

Anything that pertains to a single tool — handler logic, options panel, shaders/algorithms, the data model the tool persists into the document, the icon — lives in that tool's folder under `src/core/tools/{Pascal}/`. Don't put tool-specific code in `src/core/services/`, `src/utils/`, `src/types/`, or anywhere else. Cross-tool helpers go in `src/core/tools/_shared/`. The Brush tool's `brushPreset.ts` is the canonical example: it's a serialized document type, but it's still owned by the Brush tool because that's the tool that defines the data model.

### Hooks (`src/core/services/`)

Each hook owns **one cohesive concern** and encapsulates all business logic for that domain. Hooks accept a `canvasHandleRef` and `dispatch` as inputs and never hold UI state. Examples of the expected granularity: file ops (`useFileOps`), layer manipulation (`useLayers`), undo/redo history (`useHistory`), canvas dimension transforms (`useCanvasTransforms`), spritesheet/animation export (`useSpritesheetAnimationOps`), color-mode conversion (`useColorMode`), format remount (`useFormatRemount`), mount-time lifecycle (`useAppLifecycle` — brush bootstrap, memory error capture, recent files, startup file, selection-flag mirror, clone-stamp notification). If a hook is doing two clearly unrelated jobs, split it.

### Components (`src/ux/`)

| Category | Path | What it can access |
|---|---|---|
| **Widgets** | `ux/widgets/` | Stateless, reusable anywhere. No app state. |
| **Main UX Framework** | `ux/main/` | Top-level layout chrome. |
| **Floating window chrome** | `ux/windows/` | Generic `ToolWindow` wrapper + tool-specific options (brush). Effect/adjustment/filter panels do **not** live here — they're co-located with their effect under `src/core/effects/{Name}/`. |
| **Modals** | `ux/modals/` | Wraps `ModalDialog`. Dialogs that block the main UX. |

**The key rule:** a widget must never reach into `AppContext`, and a layout (main) component must never duplicate logic that belongs in a panel. For example, `RightPanel` (`ux/main/`) hosts `ColorPicker` and `LayerPanel` — it renders them, not their contents.

**Folder conventions:** one component per folder with a PascalCase name. Each folder contains exactly `ComponentName.tsx` and `ComponentName.module.scss`. Always check existing components before building new UI.

---

## Tools

Every tool — pencil, brush, eraser, marquee, lasso, dodge, blur, etc. — is a class implementing `ITool`, registered in `toolRegistry`, and rendered by the toolbar from registry data. Adding a new tool is one folder.

### `ITool` interface

Defined in `src/core/tools/_shared/ITool.ts`. Each tool declares:

- **Identity**: `id` (matches the `Tool` union in `src/types`), `label`.
- **Toolbar presentation**: `shortcut`, `icon` (a `ReactElement`, typically `<SvgIcon src={...} />`), `placement` (`{ group, row, column } | null`).
- **Optional**: `customRender(props)` — replaces the default toolbar button entirely (Shape uses this for its caret + flyout).
- **Shortcut cycling**: `shortcutCycle?` — id of the tool to advance to when this tool's shortcut is pressed while it's already active. Pairs (`lasso ↔ polygonal-selection`, `magic-wand ↔ object-selection`) declare each other.
- **Behaviour flags**: `modifiesPixels`, `skipAutoHistory`, `paintsOntoPixelLayer`, `worksOnAllLayers`, `pixelOnly`, `indexed8Unsupported`. The toolbar / Canvas read these to gate the tool.
- **Runtime**: `createHandler()` returns a fresh `ToolHandler` per activation; `Options` is the right-side options-bar component.

### Registry & toolbar

`src/core/tools/toolRegistry.ts` — `register(tool)`, `get(id)` / `require(id)`, `all()`, `toolbarGroups()` (derives the 2D toolbar layout from each tool's `placement`), `resolveShortcutCycle(key, active)`.

`src/core/tools/index.ts` registers every tool side-effect-style on import. It also re-exposes the registry as `TOOL_REGISTRY: Record<Tool, ITool>` for callers (Canvas, ToolOptionsBar) that index by id.

`src/ux/main/Toolbar/Toolbar.tsx` iterates `toolRegistry.toolbarGroups()` to render groups → rows → buttons. Tools with `customRender` produce their own button; everything else uses the standard one. Pixel-only / indexed8-unsupported flags drive disabled state.

### Adding a new tool

1. Create `src/core/tools/{PascalName}/`.
2. Add the new id to the `Tool` union in `src/types/index.ts`.
3. Drop a `{name}.svg` into the folder; the tool class imports it as `?raw` and renders it via `<SvgIcon src={...} />`.
4. Write `{Name}.tsx` defining a class implementing `ITool` and `export const xxxTool: ITool = new XxxTool()`. Tool-specific algorithm files (`*Stroke.ts`, `dodgeBurn.ts`-style helpers) live in the same folder.
5. Add the import + array entry in `src/core/tools/index.ts`.

### Tool runtime context

Each handler factory receives a **`ToolContext`** on every pointer event: `renderer`, `layer`, `layers`, `primaryColor`, `secondaryColor`, `selectionMask`, `swatches`, `swatchGroups`, `pixelFormat`, `tiledMode`, `zoom`, plus mutators (`growLayerToFit`, `commitStroke`, `setColor`, `setSwatch`, `setActiveLayer`, `setActiveTool`, `setCursor`, `panViewport`, `setZoom`) and the parametric-layer helpers (`addTextLayer`, `previewShapeLayer`, etc).

Drawing options (size, opacity, hardness, etc.) are stored in a **module-level options object** (e.g. `export const brushOptions = { size: 10, ... }`) inside the tool's folder. This is intentional: pointer event handlers run synchronously and cannot read React state. The options object is also exported so `Canvas.tsx` can read the current brush size for cursor rendering without coupling to React state.

**Coordinate spaces:** `GpuLayer.data` is in **layer-local** space. The stride depends on `layer.format` (see Pixel Formats). Canvas-space operations (e.g. `selectionStore.floodFillSelect`) require a canvas-sized buffer. When sampling only the active layer at canvas-space coordinates, scatter `layer.data` into a canvas-sized buffer offset by `layer.offsetX, layer.offsetY`.

---

## Effects, adjustments, filters

All adjustments, real-time effects, and filters share one architecture and one folder tree under `src/core/effects/`. The terms only differ in which top menu they appear under (`adjustments` / `effects` / `filters`); the runtime treats them uniformly as **pipeline effects** — non-destructive layers inserted into the layer stack and re-rendered every frame from the render plan.

### Per-effect folder

Every effect lives in `src/core/effects/{PascalName}/` containing:

- **`{Name}Effect.tsx`** — implements `IPipelineEffect`. Owns the effect's id, label, menu placement, default params, plan-entry builder, encode body, and panel reference. Optional `onFrameEnd?()` / `onDestroy?()` for effects with cross-frame texture caches.
- **`{Name}Panel.tsx`** (or `{Name}Options.tsx`) **+ `.module.scss`** — the right-side panel UI rendered when the layer is selected.
- **`*.wgsl`** — every WGSL shader the effect needs.

Cross-effect helpers live in `src/core/effects/_shared/`.

### `IPipelineEffect` interface

Defined in `src/core/effects/IPipelineEffect.ts`:

```ts
interface IPipelineEffect<L extends EffectLayerState, Op extends EffectRenderOp> {
  readonly id: L["effectType"] & Op["kind"];
  readonly label: string;
  readonly menu: { root: "adjustments" | "effects" | "filters"; submenu?: string; instant?: boolean; shortcut?: string };
  readonly defaultParams: L["params"];
  buildPlanEntry(layer: L, ctx: PlanContext): Op;
  encode(ctx: EncodeContext, entry: Op): void;
  readonly Panel: ComponentType<PanelProps<L>>;
  onFrameEnd?(): void;
  onDestroy?(): void;
}
```

### Registry & dynamic discovery

`src/core/effects/effectRegistry.ts` is a small `Map<string, IPipelineEffect>`. Registration happens via side-effect imports in `src/core/effects/index.ts`. Importing `@/core/effects` is the single load-bearing step that makes every effect reachable from the plan builder, encoder, and panel host.

Shaders are auto-discovered by `src/core/effects/shaderLoader.ts` (`import.meta.glob('./**/*.wgsl', { query: '?raw', eager: true })`). Consumers fetch by basename via `getShader("filter-gaussian-h")`. There is no hand-maintained barrel — dropping a `.wgsl` file inside any effect folder makes it discoverable.

### Runtime services

Effects don't construct their own pipelines. One shared **`EffectRuntime`** (`src/graphics/webgpu/EffectRuntime.ts`) provides cached pipeline / sampler / scratch-texture / render-pass primitives that every effect uses. Effects access it via `engine.runtime` from their `encode` body.

`EffectEncoder` is the dispatcher that owns the single `EffectRuntime` instance. Cross-frame texture caches (e.g. Bloom's downsampled glow buffers) are owned by the effect itself as module-level state and evicted via `onFrameEnd`.

### Adding a new effect

1. Create `src/core/effects/{PascalName}/`.
2. Add the `EffectType` literal + `EffectParamsMap` entry in `src/types/index.ts` (and the `*EffectLayer` interface + union).
3. Write the `.wgsl` shader(s) directly in the folder.
4. Add a render-plan op variant (if needed) in the relevant `EffectRenderOp` union, and the render-plan mapping in `src/ux/main/Canvas/canvasPlan.ts`.
5. Write `{Name}Effect.tsx` implementing `IPipelineEffect` — its `encode` body uses `engine.runtime.getRenderPipelinePair(...)`.
6. Write `{Name}Panel.tsx` + `.module.scss` for the right-panel UI.
7. Register the effect in `src/core/effects/index.ts` (one import line + one `effectRegistry.register(...)` line).

The WGSL uniform struct must match the `Float32Array`/`Uint32Array` packed inside the effect's `encode` exactly (byte offsets, padding, total size).

### Unified Rasterization Pipeline

- Flatten, merge, and export run through `src/graphics/rasterization/`. Don't add ad-hoc compositing paths.
- The pipeline only supports `RasterBackend = 'gpu'`. There is no CPU fallback.
- `rasterizeDocument({ plan, width, height, reason, renderer })` is the single entry point. `reason` is `'flatten' | 'export' | 'sample' | 'merge'`.
- Temporary preview-bypass state must never leak into final flatten/export/merge outputs.
- If flatten/export/merge fails, surface the error to the user. Never silently no-op.

---

## State

Global app state (active tool, colors, layers, swatches, selectedLayerIds, brushes, animations, …) flows through `AppContext` via `useReducer`. The pattern for adding new state:
1. Add the field to `AppState` in `src/types/index.ts`.
2. Add the reducer action to `src/core/store/AppContext.tsx`.
3. Export `AppAction` so hooks outside `AppContext.tsx` can dispatch.

Tab state (multi-document) lives in `useTabs`. Canvas pixel data lives in WebGPU while a tab is active and is serialized to `savedLayerData` only when the tab is backgrounded. Operations that change canvas dimensions (resize, crop) must increment `canvasKey` on the tab record to force a Canvas remount with the new size.

Avoid re-initializing canvas layers in effects that list `rendererRef.current` as a dependency — use a `hasInitializedRef` guard instead.

**Module-level singletons** (`src/core/store/`): stateful objects that tools and canvas components import directly without going through React. They are not React state; update them imperatively and call their `notify()` to trigger subscribers.

Inventory: `selectionStore`, `historyStore`, `clipboardStore`, `adjustmentClipboardStore`, `adjustmentPreviewStore`, `cursorStore`, `cropStore`, `transformStore`, `objectSelectionStore`, `polygonalSelectionStore`, `cloneStampStore`, `pixelBrushStore`, `displayStore`, `notificationStore`, `memoryStore`, `paletteCycleStore`, `brushStore`, `brushPanelStore`, `brushManagerStore`, `measureStore`, `preferencesStore`.

**`selectedLayerIds`** is kept in `AppState` (not as local panel state) so hooks like `useLayers` can act on multi-layer selections. Any action that resets the layer stack (`SET_ACTIVE_LAYER`, `REORDER_LAYERS`, `RESTORE_LAYERS`, `NEW_CANVAS`, `OPEN_FILE`, `RESTORE_TAB`, `SWITCH_TAB`) also resets `selectedLayerIds` to `[]`.

---

## Pixel Formats

Every layer and every document has a `PixelFormat`:

| Value | `layer.data` type | Bytes/pixel | Notes |
|---|---|---|---|
| `'rgba8'` | `Uint8Array` | 4 | Standard 8-bit RGBA (0–255 per channel) |
| `'rgba32f'` | `Float32Array` | 16 | 32-bit float RGBA (0.0–1.0 per channel; values >1 valid for HDR) |
| `'indexed8'` | `Uint8Array` | 1 | Palette indices (0–254); 255 = transparent sentinel |

`PixelFormat` is defined in `src/types/index.ts`. `AppState.pixelFormat` holds the document-level format and is set by `SET_PIXEL_FORMAT`, `NEW_CANVAS`, `OPEN_FILE`, `RESTORE_TAB`, `SWITCH_TAB`. `TabRecord.pixelFormat` mirrors it via a `useEffect` in `App.tsx`.

**Key format rules for tool authors:**
- `blendPixelOver` (`src/core/tools/_shared/primitives.ts`) always receives `r/g/b/a` as **0–255** from callers, regardless of format. It normalizes internally for `rgba32f`. For `rgba32f`, callers may pass `srcFloat: readonly [number, number, number, number]` in native `[0,1]` (or `>1` for HDR) to bypass the `÷255` normalisation.
- `renderer.samplePixel(layer, lx, ly)` returns `[r, g, b, a]` where values are 0–255 for `rgba8`, 0.0–1.0 for `rgba32f`, and `[index, 0, 0, 255]` for `indexed8`.
- `renderer.drawPixel(layer, lx, ly, r, g, b, a)` expects values in the layer's native range.
- `renderer.flushLayer(layer, palette?)` — must pass `palette` (the current `state.swatches`) when `layer.format === 'indexed8'`.
- Any code that reads `layer.data[i+3] / 255` or writes `Math.round(outA * 255)` directly is broken for `rgba32f`. Any code that reads/writes 4 bytes per pixel is broken for `indexed8`.
- `readLayerPixels(layer)` and `readFlattenedPixels(layers)` return `Float32Array` for `rgba32f` layers — never type-assert as `Uint8Array`.

**Tab serialization:** `serializeActiveTabPixels` and the history-jump path encode indexed8 layers as `data:raw/indexed8;base64,…` and rgba32f layers via `f32TransferStore`. The history store holds `layerPixels: Map<string, Uint8Array | Float32Array>`.

**New Image dialog:** the Color Mode selector lets users pick `rgba8`, `rgba32f`, or `indexed8` when creating a new document.

---

## WebGPU (`src/graphics/webgpu/`)

`rendering/WebGPURenderer.ts` is the GPU pixel read/write layer. It operates on `GpuLayer` objects:

```ts
interface GpuLayer {
  id: string
  name: string
  texture: GPUTexture
  data: Uint8Array | Float32Array  // format-dependent
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

Key methods:
- `readLayerPixels(layer)` → `Uint8Array | Float32Array` in **layer-local** space
- `readFlattenedPixels(layers)` → async, canvas-sized composite buffer
- `flushLayer(layer, palette?)` — uploads `layer.data` to GPU texture; pass `palette` for `indexed8`
- `growLayerToFit(layer, canvasX, canvasY, extraRadius?)` — expands layer buffer; correctly allocates `Float32Array` for `rgba32f` and 1-byte `Uint8Array` for `indexed8`

Don't bypass `WebGPURenderer` to manipulate pixel data directly.

The render plan for the on-screen preview is built in `src/ux/main/Canvas/canvasPlan.ts` and consumed by `WebGPURenderer`. Layer compositing for flatten/merge/export goes through the unified rasterization pipeline (`src/graphics/rasterization/`).

---

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

A few non-obvious rules:
- Replay coalesced events (`getCoalescedEvents`) for `pen`/`touch` only — high-polling mice (1000 Hz) generate 16+ coalesced events per frame and will tank performance.
- Use `e.button !== 0` guards on `pointerdown`/`pointerup` to ignore barrel-button and eraser-end events from Wacom tablets.
- Detect silent pen-lift (tip lifts without `pointerup`) by checking `!(e.buttons & 1)` on `pointermove`.
- Pass `e.timeStamp` (not `performance.now()`) through `ToolPointerPos` so velocity-tracking tools get accurate timing from coalesced hardware timestamps.
- For velocity-aware tools, use the **outer event's** `e.pressure` for all coalesced samples — per-coalesced pressure fluctuates at hardware polling rate and causes jitter.

### Canvas Cursor

For tools with a custom cursor (brush, eraser), hide the native cursor (`cursor: none`) and drive a CSS circle div imperatively via a ref on every `onHover` call. Use `white border + dark box-shadow` for visibility on both light and dark canvases. Never update cursor appearance through React state.

### Drawing / Pixel Operations

- All pixel blending uses **Porter-Duff "over" compositing** via `blendPixelOver` in `src/core/tools/_shared/primitives.ts`.
- `blendPixelOver` callers pass `r/g/b/a` as **0–255** for `rgba8`/`indexed8` layers. For `rgba32f` layers, callers may pass `srcFloat: readonly [number, number, number, number]` in native `[0,1]` (or `>1` for HDR) to bypass the `÷255` normalisation. The clone stamp always uses `srcFloat` when the source buffer is a `Float32Array`.
- Track per-stroke coverage with a `Map<number, number>` (key = packed pixel index, value = max effective alpha applied) to prevent opacity accumulation within a single stroke.
- Thick brush shapes: **circle stamp** for hard edges; **capsule SDF** for anti-aliased thick lines. Both helpers live in `_shared/primitives.ts`.
- When adding a new drawing operation, always branch on `layer.format` for `rgba32f` (float math, no rounding) and `indexed8` (palette-index write, no alpha blending). Don't assume `rgba8`.

---

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

---

## Case-sensitivity gotcha

macOS's filesystem is case-insensitive but TypeScript's compiler is case-sensitive. Don't put a `Foo.tsx` and a `foo.ts` in the same folder — they collide on disk and TS will error. The convention used in this codebase: when a tool folder needs both a class file and an algorithm file, give the algo file a descriptive suffix (`cloneStampStroke.ts`, `brushPreset.ts`, `eraseStroke.ts`) rather than the bare lowercase tool name.
