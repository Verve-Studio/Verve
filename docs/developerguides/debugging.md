# Debugging Guide

Verve has two independent processes, and debugging each one requires different tools and approaches.

---

## Opening DevTools

### From the running app

The **Help** menu → **Open DevTools** opens Chrome DevTools for the renderer process. This is the DevTools you already know from browser development: console, Sources, Network, Memory, etc.

You can also call `window.api.openDevTools()` from the renderer console at any time.

### Programmatically in `electron/main/index.ts`

```typescript
mainWindow.webContents.openDevTools({ mode: 'detach' })
```

Add this call after `mainWindow.loadURL(...)` for automatic DevTools on every launch during development.

---

## Debugging the renderer process

The renderer is a standard React app running in Chromium. Everything under `src/` is debuggable via Chrome DevTools.

### Console

Open DevTools → Console. All `console.log` / `console.error` calls from `src/` appear here.

The app uses prefixed logging for easy filtering:
```
[useFilters] Gaussian blur failed: ...
[Fill] WASM flood fill failed: ...
[WebGPURenderer] flushLayer: layer not found
```

Filter by prefix in the console to narrow down noise.

### React DevTools

Install the [React Developer Tools](https://chromewebstore.google.com/detail/react-developer-tools/fmkadmapgofadopljbjfkapdkoienihi) extension. In Electron dev mode, the extension loads automatically if installed in Chrome and Electron is configured for it.

With React DevTools you can:
- Inspect the component tree and see which props/state each component holds
- Trace `dispatch` calls in `AppContext` to see which action fired and what state changed
- Profile re-renders to find performance bottlenecks

### Breakpoints in the renderer

In Chrome DevTools → Sources, navigate to `src/` files. The dev build includes source maps, so you can set breakpoints in TypeScript source files directly.

Useful breakpoint locations:
- `src/core/services/useFilters.ts` — step through filter application
- `src/ux/main/Canvas/Canvas.tsx` `handlePointerDown` — trace tool dispatch
- `src/core/store/AppContext.tsx` `appReducer` — watch state transitions

### Inspecting the WebGPU render pipeline

Chrome DevTools does not have a built-in WebGPU profiler, but you can use:

- **`console.time` / `console.timeEnd`** around compute passes to measure timings
- **[WebGPU Inspector browser extension](https://chrome.google.com/webstore/detail/webgpu-inspector/)** — captures GPU commands frame by frame
- Add `label` properties to every `GPUComputePipeline` and `GPUCommandEncoder` you create; they appear in GPU profiles and error messages

### AppState inspection

You can read the current app state at any time from the DevTools console:

```javascript
// The AppContext value is not directly accessible from the console,
// but you can add a debug handle in App.tsx during development:
window.__VerveState = stateRef
// Then in the console:
window.__VerveState.current.layers
```

### Singleton stores

All module-level singletons are importable. In DevTools Sources you can inspect them via `window` if you assign them:

```typescript
// Temporary debug helper in a component:
import { selectionStore } from '@/core/store/selectionStore'
;(window as any).__sel = selectionStore
```

Then in the console: `__sel.mask`, `__sel.hasSelection()`.

### WASM debugging

WASM functions are compiled with `-O2` (no debug symbols) for performance. To debug WASM logic:

1. Temporarily change the optimization flag in `wasm/CMakeLists.txt` from `-O2` to `-O0 -g`.
2. Add `-sASSERTIONS=2` to the Emscripten flags for bounds-checking.
3. Rebuild: `npm run build:wasm`.
4. Chrome DevTools → Sources will now show C++ source files alongside the WASM.

For input/output verification without a debugger, add temporary logging in the TypeScript wrapper:

```typescript
// src/wasm/index.ts (temporary)
export async function floodFill(pixels, width, height, x, y, r, g, b, a, tolerance) {
  console.log('[WASM floodFill] input size:', pixels.length, 'coords:', x, y)
  const result = await /* ... */
  console.log('[WASM floodFill] output size:', result.length)
  return result
}
```

---

## Debugging the main process

The main process runs in Node.js, not in Chromium. DevTools cannot inspect it directly.

### electron-vite dev mode — main process logs

`console.log` calls in `electron/main/` appear in the **terminal** where you ran `npm run dev`, not in DevTools.

### Attaching a Node.js debugger

1. Add `--inspect` to the Electron launch arguments in `electron.vite.config.ts`:
   ```typescript
   main: {
     build: { ... },
     inspect: true,          // electron-vite's built-in inspect flag
   }
   ```
   Or pass it manually: `electron --inspect=5858 .`

2. Open `chrome://inspect` in any Chrome window.
3. Click **Configure** → add `localhost:5858`.
4. The main process will appear under "Remote Target". Click **inspect**.

This gives you a full Node.js debugger: breakpoints, call stacks, variable inspection.

### IPC debugging

All IPC calls go through `electron/main/ipc.ts`. To trace every call, add a middleware log:

```typescript
// electron/main/ipc.ts
ipcMain.on('*', (event, channel, ...args) => {
  console.log('[IPC]', channel, args)
})
```

Or more precisely, log inside each handler:

```typescript
ipcMain.handle('dialog:openFile', async () => {
  console.log('[IPC] dialog:openFile called')
  const { filePaths } = await dialog.showOpenDialog({ ... })
  console.log('[IPC] dialog:openFile result:', filePaths)
  return filePaths[0] ?? null
})
```

### Renderer-side IPC debugging

Every `window.api.*` call is a thin wrapper over `ipcRenderer.invoke`. To log them:

```typescript
// Temporary in any renderer file:
const origOpen = window.api.openFile
window.api.openFile = async () => {
  console.log('[api] openFile called')
  const result = await origOpen()
  console.log('[api] openFile result:', result)
  return result
}
```

---

## TypeScript errors

Run the type checker without building:

```bash
npm run typecheck
```

This runs tsc on both `tsconfig.node.json` (main/preload) and `tsconfig.web.json` (renderer) and reports all errors.

Common errors and their causes:

| Error | Likely cause |
|---|---|
| `Cannot find module 'electron'` in `src/` | Electron imported from renderer. Move to main/preload. |
| `Property 'api' does not exist on type 'Window'` | Missing `electron/preload/index.d.ts` declaration |
| `Expected N arguments, but got M` | Signature mismatch between hook return type and call site |
| `Type ... is not assignable to type 'AdjustmentType'` | New adjustment type not added to the union in `src/types/index.ts` |
| `Object is possibly 'null'` | Missing null-check around `canvasHandleRef.current` |

---

## Common runtime issues

### Canvas is black / nothing renders

- Check the DevTools console for WebGPU errors (e.g., "Validation error", "Out of memory").
- `WebGPURenderer` may have failed to initialize. Look for `[WebGPU] init failed` in the console.
- The `<Canvas>` component only mounts when a tab is open. Verify `tabs.length > 0` in App state.

### Tool does nothing when clicking the canvas

- The tool's `onPointerDown` only fires on left-click (`e.button === 0`). Barrel buttons and eraser ends on Wacom tablets send `button !== 0`.
- Verify the active layer is a pixel layer. Most tools early-return if the active layer has a `type` field (adjustment, group, text, shape).
- Verify the tool is registered in `TOOL_REGISTRY` in `src/tools/index.ts`.

### Filter applies to the whole canvas ignoring the selection

- The filter dialog must read `selectionStore.mask` at open time (not at apply time) and store it in a ref. Apply-time reads may miss the mask if it changed.
- `applySelectionComposite(result, original, mask)` must be called before `handle.writeLayerPixels(...)`. Missing this call means the full layer gets overwritten.

### Undo doesn't restore the expected state

- `captureHistory('Label')` must be called **after** pixel writes are complete, not before. For async operations, capture inside the `.then()` / `await` continuation.
- Each distinct user action should produce exactly one history entry. Multiple `captureHistory` calls in one logical operation produce multiple undo steps.

### Adjustment panel doesn't open

- `dispatch({ type: 'SET_OPEN_ADJUSTMENT', payload: layerId })` must be dispatched. This sets `state.openAdjustmentLayerId`, which `App.tsx` uses to mount `<AdjustmentPanel>`.
- The layer's `parentId` must point to a pixel/text/shape layer. Adjustment layers attached to groups or other adjustments are treated differently.

### WASM call hangs or crashes

- Verify you passed the correct buffer sizes. WASM reads `width * height * 4` bytes from the pointer; passing a smaller buffer causes a heap overread.
- Check that `getPixelOps()` resolved successfully. If the `.wasm` file is missing, it throws — look for an unhandled rejection in the console.
- Memory growth: always use the `withInPlaceBuffer` wrapper from `src/wasm/index.ts`. Never cache the `HEAPU8` reference across async calls — WASM memory can be reallocated (grown) during any call.

---

## Performance profiling

### Identifying slow re-renders

In React DevTools → Profiler, record a few interactions and look for components that re-render unexpectedly. Common causes:

- `App.tsx` callbacks not wrapped in `useCallback` → new function reference on every render → downstream `React.memo` bypassed
- `dispatch` calls that produce a new `AppState` reference even when nothing changed (check reducer for accidental spread mutations)

### Identifying slow GPU operations

Add `console.time`/`console.timeEnd` around `EffectEncoder.encode` calls or `rasterizeDocument`:

```typescript
console.time('gaussianBlur')
const result = await gaussianBlur(pixels, width, height, radius)
console.timeEnd('gaussianBlur')
// Output: gaussianBlur: 42ms
```

Compute passes typically run in < 10 ms for standard HD images. If a pass is slow:
- Check the workgroup size in the WGSL shader (should be 8×8 or 16×16 for 2D image ops).
- Check if you're creating new `GPUBuffer`s on every call — buffer creation is expensive; reuse buffers.
- Check if an intermediate texture format is `rgba8unorm` when it should be `rgba16float` (precision issues that cause extra passes).

### Memory profiling

Chrome DevTools → Memory → Heap Snapshot. Take a snapshot before and after a heavy operation (e.g., opening a 4K image) to check for leaks. Common leak sources:

- Forgetting to call `_free(ptr)` after a WASM operation (always use the `withInPlaceBuffer` wrapper).
- Holding references to large `Uint8Array` pixel buffers in closures inside hooks.
- Adjustment mask `GpuLayer` objects that are never destroyed when a layer is deleted.
