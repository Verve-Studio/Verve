# 029 · Pixelate does S² work per pixel and can hang the GPU

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Stability / Performance |
| Area | Effects / Pixelate |
| Verified | No — reported by reviewer |

## Problem
Every output pixel re-averages its whole block. The panel allows block sizes up to 500: at S=500 that's 250k `textureLoad`s per pixel, which hits Windows' 2 s GPU timeout (TDR → device lost, see [023](023-device-lost-handling.md)) on any real document.

## Where
- `src/core/effects/Pixelate/filter-pixelate.wgsl:40-45`

## Suggested fix
Two passes: reduce into a `ceil(w/S) × ceil(h/S)` texture (one invocation per block, or a compute reduction), then upsample with nearest sampling.

## Done when
- Pixelate at block size 500 on an 8K document renders in well under a frame budget with no device loss.


## Resolution
Pixelate is now two passes. `fs_pixelate_reduce` renders into a `ceil(W/S)×ceil(H/S)` scratch target (one invocation per block, one load per source pixel in total), then `fs_pixelate_expand` does one load per output pixel. The intermediate uses the new `EffectRuntime.makeScratchTex()` (doc-format scratch). Shader validated with naga. `pixelate.ts` (`runPixelate`) has no callers and was left alone.
