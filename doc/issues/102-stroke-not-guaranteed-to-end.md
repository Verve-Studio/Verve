# 102 · A stroke can get stuck (no pointer-up, timers, strokeActive)

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Stability |
| Area | Input pipeline / Brush |
| Verified | Yes |

## Problem
`handleUp` skips `onPointerUp` when `buildCtx()` returns null (active layer deleted/undone/locked mid-stroke). Nothing is in try/finally, so an exception in a tool also leaves the stroke open: Brush's build-up timer keeps stamping, `renderer.strokeEnd()` never runs (effects stay bypassed, full re-composite forever) and no history is recorded. Layer/history shortcuts are not blocked during a stroke, and the stroke isn't pinned to its layer.

## Where
- `src/core/services/useCanvasPointerInput.ts:165-180`
- `src/core/services/useToolContext.ts:112-160`
- `src/core/services/useKeyboardShortcuts.ts`

## Suggested fix
Pin the stroke's context (layer etc.) at pointer-down and reuse it until pointer-up; wrap down/move/up in try/finally that always ends the stroke (`strokeEnd`, clear strokeRef); expose an `isStrokeActive` flag and ignore layer/history shortcuts while it's set.

## Done when
- Deleting/undoing a layer mid-stroke or an exception in a tool never leaves a stuck stroke.

## Resolution
Stroke context from pointer-down is pinned; pointer-up uses it when the live context is missing or points at another layer, provided the layer is still live (renderer.isLayerLive). Pointer-up runs in try/finally: if the tool can't finish or throws, the new ToolHandler.onCancel runs (Brush stops its build-up timer, drops the pending flush and per-stroke state) and renderer.strokeEnd() closes an open stroke. A capture-phase window keydown listener swallows shortcuts (except modifiers and Space) while a stroke is active, so undo/delete/new-layer/paste can't swap or destroy the layer mid-stroke.
