# 133 · Mid-stroke thumbnail refresh, double upload on grow, zoom scans mask

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Low |
| Category | Performance |
| Area | Rendering / Canvas |
| Verified | Yes |

## Problem
The Navigator mirror refreshes during strokes; `growLayerToFit` uploads the full layer and then marks it fully dirty again; Ctrl+wheel zoom scans the whole selection mask per event.

## Where
- `src/core/services/useCanvasRenderLoop.ts:295`
- `src/graphics/webgpu/rendering/WebGPURenderer.ts:594`
- `src/ux/main/Canvas/Canvas.tsx:235-256`

## Suggested fix
Defer the mirror until stroke end; skip the redundant re-upload; cache the selection bbox.

## Done when
- No mirror work mid-stroke; one upload per grow; zoom doesn't scan the mask.

## Resolution
The render loop owes (defers) the Navigator mirror update while a stroke is active; the full render triggered by strokeEnd flushes it. Layer growth no longer uploads twice: replaceTexture takes alreadyUploaded (true for rgba8/rgba32f, whose grow path uploads the new buffer). The Ctrl+wheel selection anchor is cached per (mask, selectionRevision) instead of scanning the mask on every event.
