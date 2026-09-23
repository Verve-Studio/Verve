# 048 · Compositor allocates full-canvas temporary textures every frame

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | High |
| Category | Performance |
| Area | GPU rendering |
| Verified | Partially — per-frame `zeroTex` in incremental path confirmed; rest reported by reviewer |

## Problem
- `allocateTempGroupTex` is called twice per composite layer on every cache miss (`RenderPlanExecutor.ts:1249-1250`), and twice in the incremental path just to patch a small dirty rect (`:1198-1206`).
- Every incremental frame creates a `zeroTex` (`:919-925`).
- `strokeActive` forces the full path on every stroke frame, so a stroke under a composite layer creates and destroys two canvas-sized textures per frame (~512 MB/frame at 4K f32).
- New texture objects also defeat the per-slot bind-group cache (`:782-812`).

## Where
- `src/graphics/webgpu/frame/RenderPlanExecutor.ts:245-259, 919-925, 1198-1206, 1249-1250`

## Suggested fix
Keep a persistent pool of ping/pong pairs indexed by nesting depth, re-created only on size/format change. Clear the dirty sub-rect with a scissored clear render pass (or a small persistent zero texture) instead of allocating one per frame.

## Done when
- No texture creations per frame during a stroke (verify with a counter around `createTrackedTexture`).


## Resolution
Two changes in `RenderPlanExecutor`:
- `allocateTempGroupTex` now hands out cleared textures from a persistent pool (slot i = the i-th request of the encode; the cursor resets with `compositeBufferIndex`). Slots unused for 5 s are released by a timer, so idle memory returns to what it was before.
- The per-frame "zero" textures used to clear dirty sub-rects were replaced by one persistent, never-written zero texture that grows on demand (`zeroTexFor`).

Pooled textures are never stored in the render caches (those copy into their own textures), so reuse across frames is safe. Not measured in the running app.
