# 053 · Text-edit effect re-runs on every Canvas render (every keystroke)

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | Canvas / Text tool |
| Verified | No — reported by reviewer |

## Problem
`Canvas.tsx:443` lists `doRender` as an effect dependency; `doRender` is a new closure every render (`useCanvasRenderLoop.ts:206`, not memoized). Each keystroke dispatches `UPDATE_TEXT_LAYER`, re-renders Canvas, and the effect cleanup + setup run: `setPreviewMode(false)` then `(true)`. Each call invalidates `lastPlanFp` and `hasStableTex` (`RenderPlanExecutor.ts:414-419`) and triggers 2 doRenders, so every keystroke costs full re-composites.

## Where
- `src/ux/main/Canvas/Canvas.tsx:430-443`
- `src/core/services/useCanvasRenderLoop.ts:206`

## Suggested fix
Call `doRenderRef.current()` inside the effect and use deps `[editingLayerId]`. Consider memoizing `doRender` with a ref-based stable wrapper.

## Done when
- Typing in a text layer does not toggle preview mode per keystroke.


## Resolution
The text-edit effect in `Canvas.tsx` calls `doRenderRef.current()` (the ref `useCanvasRenderLoop` already exposes) and depends only on `[editingLayerId, doRenderRef, glLayersRef, rendererRef]`, so it no longer re-runs on every Canvas render or keystroke.
