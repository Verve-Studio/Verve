# 004 · Two Bloom layers with different Quality freeze the canvas

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Stability |
| Area | Effects / Bloom |
| Verified | Yes — confirmed in code during review |

## Problem
Bloom's module-level `texCache` is a single slot keyed only by `quality` + `format`. With two Bloom layers at different Quality settings, the second `encode` calls `destroyTrackedTexture` on the first layer's extract/blur textures, which are already recorded in the same, unsubmitted command encoder. `queue.submit` then fails validation on every frame and the canvas stops updating.

## Where
- `src/core/effects/Bloom/BloomEffect.tsx:76-83`

## Suggested fix
Make the cache a `Map` keyed by `quality|format|width|height`. If an entry must be replaced mid-frame, push the old textures to `runtime.pendingDestroyTextures` (destroyed after submit) instead of destroying immediately. Evict unused entries after a grace period (see [066](066-effect-cache-eviction-too-eager.md)). Check other effects with single-slot caches (Halation, DropShadow, Outline, LensBlur kernel cache) for the same pattern.

## Done when
- Two Bloom layers at Full and Quarter quality render together without GPU validation errors.


## Resolution
New `src/core/effects/_shared/textureSetCache.ts` (`TextureSetCache`): one entry per key (`WxH:format[:quality]`), LRU overflow is handed to `runtime.pendingDestroyTextures` (destroyed after submit), idle entries are freed in `onFrameEnd` after 10 s. Bloom, Bevel, DropShadow (+Glow), Halation, InnerShadow (+InnerGlow) and Outline were converted. Keys now also include size, so a stale-size cache can no longer be reused. Curves keeps its own per-layer LUT cache.
