# 132 · Per-pixel allocation in samplePixel/blendPixelOver and pencil/eraser overdraw

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | Tools / primitives |
| Verified | Yes |

## Problem
`renderer.samplePixel` allocates per pixel; pencil/eraser clear the full touched buffer each stroke (no `lastDirtyRect`); eraser grows layers for nothing.

## Where
- `src/core/tools/_shared/primitives.ts:272`
- `src/core/tools/Eraser/Eraser.tsx:89-91`

## Suggested fix
Read `layer.data` directly in `blendPixelOver`; record stroke bbox for touched clearing; don't grow on erase.

## Done when
- No per-pixel allocations in the shared blend path.

## Resolution
blendPixelOver reads and writes layer.data directly for rgba8/rgba32f (the renderer path is kept for indexed8), removing the per-pixel samplePixel tuple. TouchedBuffer records a write box through noteTouchedWrite in every shared JS writer (blendPixelOver, erasePixelOp, dodge/burn), and acquireTouchedBuffer clears only the union of that box and lastDirtyRect. Brush marks the buffer untracked (for WASM kernel writes), so a missing lastDirtyRect still forces a full clear. The eraser no longer grows layers.
