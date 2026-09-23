# 066 · Effect texture caches are evicted after any frame the effect doesn't encode

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | Effects / Bloom, Halation, DropShadow, Outline |
| Verified | No — reported by reviewer |

## Problem
The executor's output cache skips encoding on most frames, so `onFrameEnd` frees these caches on nearly every idle or stroke-throttled frame. The next interaction reallocates full-resolution textures (Bloom on rgba32f: extract + 2 scratch, 256 MB+ at 16 MP).

## Where
- `src/core/effects/Bloom/BloomEffect.tsx:265`
- `src/core/effects/Halation/HalationEffect.tsx:201`
- `src/core/effects/DropShadow/DropShadowEffect.tsx:283`
- `src/core/effects/Outline/OutlineEffect.tsx:307`
- `EffectEncoder.endFrame`

## Suggested fix
Add a grace period (N frames or seconds unused) or evict on memory pressure via `memoryStore`. Consider a shared helper in `EffectRuntime` for keyed, grace-period texture caches (also fixes [004](004-bloom-destroys-in-use-textures.md)).

## Done when
- Toggling between idle and painting doesn't reallocate effect scratch textures.


## Resolution
Fixed with 004: `TextureSetCache` evicts only after 10 s unused instead of after every frame the effect wasn't encoded.
