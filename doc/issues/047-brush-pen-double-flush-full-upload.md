# 047 · Pen strokes with Brush re-upload the whole layer every frame

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | High |
| Category | Performance |
| Area | Tools / Brush, Canvas pointer input |
| Verified | Yes — confirmed in code during review |

## Problem
With a pen, `handleMoveBatch` calls `renderer.flushLayer(ctx.layer)`, which uploads the dirty patch and clears the dirty rect. Brush's `paint()` has also queued a rAF `commitPendingFlush()`. When that fires, `flushLayer` runs with `dirty === null`, and `LayerTextureStore.flush` treats that as `uploadFull` plus a full-layer frame-dirty. Every pen frame uploads the entire layer (~133 MB on a 4K rgba32f layer) and re-composites all of it.

## Where
- `src/core/tools/Brush/Brush.tsx:108-141`
- `src/core/services/useCanvasPointerInput.ts:124-136`
- `src/graphics/webgpu/layers/LayerTextureStore.ts:161-179`

## Suggested fix
Make `flush()` a no-op when `dirty === null` unless the caller explicitly requests a full upload (e.g. `flushLayer(layer, palette, { full: true })`), and audit callers that rely on the implicit full upload. Alternatively skip `commitPendingFlush` when the layer has no pending dirty rect.

## Done when
- During a pen stroke on a 4K layer, each frame uploads only the dirty patch (verify with a counter or GPU capture).


## Resolution
Brush's deferred `commitPendingFlush` now calls `flushLayer` only when the layer has a pending dirty region (new `WebGPURenderer.hasPendingUpload()`), so a pen frame whose patch the coalesced batch already uploaded no longer triggers a full-layer upload. `LayerTextureStore.replaceTexture` (layer grow / replace) now marks the new, empty texture fully dirty explicitly instead of relying on "no dirty rect ⇒ full upload", so skipping empty flushes is safe.
