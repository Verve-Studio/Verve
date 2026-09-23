# 026 · Switching tools mid-stroke leaks timers and loses/corrupts state

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Stability |
| Area | Tools / Tool handler lifecycle |
| Verified | No — reported by reviewer |

## Problem
`ToolHandler` has no `onDeactivate`, and nothing checks `isDrawing` before a tool switch (`useToolHandler.ts:81`). A keyboard shortcut while the pen is down swaps the handler, and `pointerup` goes to the new handler:
- **Brush:** the build-up `setInterval` (`Brush.tsx:380`) is never cleared and keeps stamping into `lastPaintCtx.layer` forever.
- **Renderer:** `strokeStart()` is never paired with `strokeEnd()`, so effects stay bypassed.
- **Move:** a hidden text layer stays invisible (`Move.tsx:441`) and `setPreviewMode(true)` sticks.
- **Lasso:** `onPointerMove` crashes on `points[points.length-1].x` with empty `points` (`Lasso.tsx:38`).
- **History:** `handleUp` reads the *new* tool's `modifiesPixels`/label (`useCanvasPointerInput.ts:143`), so the stroke's history entry is dropped.
- **Touched buffer:** `lastDirtyRect` is stale, so the next stroke has coverage holes.

## Where
- `src/core/services/useToolHandler.ts:81`
- `src/core/services/useCanvasPointerInput.ts:143`
- `src/core/tools/_shared/types.ts` (ToolHandler)

## Suggested fix
Add optional `onCancel(ctx)` / `onDeactivate(ctx)` to `ToolHandler`. In `useToolHandler`, when switching while `isDrawing`, call it (or finish the stroke via the old handler's `onPointerUp` and capture history with the old tool's metadata). Alternatively block tool switches while drawing. Brush should `stopBuildUp()` + `drainPendingFlush()` there; Move should restore visibility and preview mode.

## Done when
- Pressing a tool shortcut mid-stroke for Brush (airbrush on), Move (text layer) and Lasso leaves no running timers, no stuck state, and a correct history entry.


## Resolution
`useCanvasPointerInput` now pins the handler and tool that received pointer-down (`strokeRef`). Moves (single, coalesced batch, tiled) and the pointer-up go to that handler even if the active tool changes mid-stroke, so it finishes normally (Brush stops build-up, `strokeEnd` runs, Move restores its hidden text layer). The auto-history label and flags come from the stroke's own tool. Lasso also ignores moves without a stroke in progress. We chose this over adding an `onCancel` hook to every tool.
