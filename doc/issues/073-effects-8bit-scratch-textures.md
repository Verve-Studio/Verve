# 073 · Several effects use 8-bit scratch textures on 32-bit float documents

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Effects / UnsharpMask, ReduceNoise, SmartSharpen, SeamlessTexture |
| Verified | No — reported by reviewer |

## Problem
These use `rt.makeRgba8Tex` and a hardcoded `.s8` pipeline. On rgba32f docs the blurred reference is clipped at 1.0 and quantized to 8 bits in linear space: shadow banding and wrong sharpening halos on HDR highlights.

## Where
- `src/core/effects/UnsharpMask/UnsharpMaskEffect.tsx:49, 62`
- `src/core/effects/ReduceNoise/ReduceNoiseEffect.tsx:61, 75`
- `src/core/effects/SmartSharpen/SmartSharpenEffect.tsx:70, 90, 105, 154, 168`
- `src/core/effects/SeamlessTexture/SeamlessTextureEffect.tsx:160`

## Suggested fix
Add `runtime.makeScratchTex(w, h, format)` and use `selectPipeline(pair, tex)` so scratch matches the destination format.

## Done when
- Unsharp Mask on an rgba32f gradient shows no banding and preserves values > 1.


## Resolution
UnsharpMask, ReduceNoise, SmartSharpen and SeamlessTexture now allocate intermediates with rt.makeScratchTex(w, h, dstTex) and pick pipelines with rt.selectPipeline(pair, dstTex), so float docs keep float intermediates. FilmGrain's 8-bit noise textures were left as-is (noise only).
