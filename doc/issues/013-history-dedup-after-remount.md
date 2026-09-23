# 013 · History de-dup can record the wrong pixels after a canvas remount

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Correctness |
| Area | History |
| Verified | No — reported by reviewer |

## Problem
History capture reuses the previous entry's buffer when `contentVersion`, geometry and length match. `contentVersion` lives in the per-renderer `LayerTextureStore`: it starts at 0 on `createLayer` and increments per flush, so it **restarts on every remount**. Example: open an image, then immediately Flip / Rotate 180° / AI Restore. "Before X" is recorded at version 1; the remount re-inits the layer to version 1; the `onReady` capture of "X" shares the pre-transform buffer. Redo (or undo back to "X") restores the untransformed image.

## Where
- `src/core/services/useHistory.ts:73-101`
- `src/graphics/webgpu/layers/LayerTextureStore.ts:60, 66, 155`

## Suggested fix
Make versions globally unique: a module-level counter shared by all `LayerTextureStore` instances (simplest), or add a per-mount epoch to the de-dup key. Alternatively force a full clone on the first capture after a remount.

## Done when
- Open → Flip → Undo → Redo shows the flipped image. Same for Rotate 180 and AI Restore.


## Resolution
`LayerTextureStore` now draws content versions from one module-level counter (`nextVersion()`), used on register, flush and replaceTexture, plus a new `bumpVersion()` for the grow path in `WebGPURenderer`. A remounted layer can no longer get a version that matches its pre-remount history entry. Render caches only compare versions for equality, so they are unaffected.
