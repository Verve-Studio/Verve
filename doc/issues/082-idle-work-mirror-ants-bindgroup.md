# 082 · Idle work runs when nothing has changed

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Performance |
| Area | Canvas render loop |
| Verified | No — reported by reviewer |

## Problem
- `useCanvasRenderLoop.ts:267` calls `scheduleMirrorUpdate()` even when `renderResult.kind === 'noop'`; each run does a full-backing, unscissored re-blit (`repaintScreenNoScissor`, line 171) plus `createImageBitmap`.
- `useMarchingAnts.ts:29-65` runs a rAF loop forever, writing `style.transform` and clearing a viewport-sized canvas every frame even with no selection.
- `DisplayPresenter.encodeBlit` creates a new bind group every frame (`DisplayPresenter.ts:204`).

## Where
- `src/core/services/useCanvasRenderLoop.ts:171, 267`
- `useMarchingAnts.ts:29-65`
- `DisplayPresenter.ts:204`

## Suggested fix
Skip the mirror update on no-op renders; only run the ants loop while a selection exists (clear once on transition to none); cache the blit bind group keyed on source texture + LUT views.

## Done when
- An idle app with no selection shows ~0% CPU/GPU in the Performance panel.


## Resolution
Render loop skips scheduleMirrorUpdate on no-op renders unless an update is owed. Marching-ants rAF does only cheap state reads while idle: it clears the overlay once when content disappears and skips all DOM/canvas work afterwards. DisplayPresenter reuses the blit bind group while srcTex, sampler and LUT views are unchanged.
