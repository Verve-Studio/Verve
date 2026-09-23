# 049 · Every state change re-renders the whole app

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | High |
| Category | Performance |
| Area | Store / React UI |
| Verified | No — reported by reviewer |

## Problem
`AppContext` provides `value={{ state, dispatch }}`, a new object each render. ~89 files call `useAppContext()`, `AppContent` reads all state, and there's no `React.memo` anywhere in `src/ux` or `App.tsx`. Every dispatch re-renders App, Layers (1747 lines with inline closures per row), Canvas, Toolbar etc. `captureActiveSnapshot` depends on `[state]` (`useTabs.ts:123`), so tab/file callbacks are recreated every time. Frequent dispatches:
- Eyedropper drag: `SET_PRIMARY_COLOR` on every pointermove with no de-dup (`Eyedropper.tsx:182-185` → `useToolContext.ts:186-191`).
- Colour-picker gradient drags (`ColorPicker.tsx:26`, `EmbedColorPicker.tsx:268, 415`).
- Zoom: `SET_ZOOM` (`Canvas.tsx:316`).

## Where
- `src/core/store/AppContext.tsx:1433`
- `src/App.tsx:69`

## Suggested fix
1. Split `dispatch` into its own context (stable).
2. Add selector subscriptions (`useSyncExternalStore` over the reducer state, or `use-context-selector`) so components subscribe to slices.
3. `React.memo` heavy panels with narrow props.
4. Skip colour dispatch when unchanged; coalesce drag dispatches to one per rAF.

## Done when
- Dragging the colour picker or eyedropper re-renders only the colour UI (verify with React Profiler).


## Resolution
Done so far:
- The reducer returns the unchanged state for no-op `SET_PRIMARY_COLOR` / `SET_SECONDARY_COLOR` / `SET_ZOOM`, so React skips the render entirely (the eyedropper hovering one colour, or a picker drag that doesn't change the value).
- The context value is memoised.
- Chromium already delivers `pointermove` at most once per frame, so extra coalescing was not added; deferring dispatches could reorder them.
- Related: 050 (menu tree memo) and 051 (Navigator) are fixed separately.

Completed:
- The reducer now runs in an external store (`AppProvider` → `createAppStore`). The new hooks are `useAppDispatch` (stable), `useAppSelector(selector, isEqual)` (on `useSyncExternalStore`, with `shallowEqual` / `shallowEqual2`) and `useGetAppState`. `useAppContext` remains only as a compatibility whole-state subscription and has no callers left.
- All 87 consumers are migrated. The 55 dispatch-only panels use `useAppDispatch`, so they never re-render from state. 27 were converted by codemod to per-key selectors (canvas sub-fields picked individually, so zoom doesn't wake them), and 5 by hand (Canvas, Pen, Pencil, ToolWindow, ColorDitheringPanel).
- `AppContent` subscribes to `AppShellState` (everything except the colours and `canvas.zoom`). Its `stateRef` is a live getter over the store.
  - `useTabs` now reads state through `getState`, so `captureActiveSnapshot` is stable. This also fixes a stale `tiledMode` read in `handleSwitchTab`.
  - `useFilters` reads colours at call time.
  - The shell hooks are retyped to `AppShellState`, so TypeScript rejects any stale access to the colour or zoom fields.
- Canvas no longer selects the colours. `useToolContext` builds the tool context from live state on every pointer event, and the brush cursor reads the primary colour at draw time. TabBar selects zoom itself.
- `React.memo` is applied to TopBar, ToolOptionsBar, TabBar, Toolbar, RightPanel, StatusBar and Canvas. MainWindow's inline closures are stable callbacks.

Result: a colour-picker or eyedropper drag re-renders only components that select the colours (ColorPicker, SwatchPanel, Toolbar colour chips, the active tool's options), and zoom re-renders only Canvas, StatusBar, TabBar, Navigator and the Zoom options.

Verification: typecheck and the production build pass, and the packaged app launches and opens a document with no console errors. Confirm with the React Profiler in the running app.
