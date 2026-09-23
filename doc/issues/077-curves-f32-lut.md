# 077 · Curves quantizes and clips on rgba32f; LUT is off by half a texel

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Effects / Curves |
| Verified | No — reported by reviewer |

## Problem
Curves uses an `r8unorm` LUT (`CurvesEffect.tsx:89`) and clamps input to [0,1] (`curves.wgsl:53`): output is quantized to 8 bits and HDR highlights clip to 1.0. The LUT coordinate `u = v` is off by half a texel, so the identity curve is not an exact identity.

## Where
- `src/core/effects/Curves/CurvesEffect.tsx:89`
- `src/core/effects/Curves/curves.wgsl:53`

## Suggested fix
Use an `r16float` / `r32float` LUT sampled at `(v*255+0.5)/256`. For inputs > 1, pass through or extrapolate using the curve's end slope.

## Done when
- The identity curve is a no-op bit-for-bit on rgba8; rgba32f shows no banding and keeps > 1 values.


## Resolution
Curve LUTs are now unrounded Float32 tables uploaded as r32float and read with textureLoad + manual lerp between texel centres (input i/255 hits entry i exactly, so identity is exact). Inputs > 1 extrapolate along the curve's end slope. buildCurvesLuts memoizes per params object and the effect keys its texture cache on LUT identity (it used to join 1024 numbers into a string every frame). The 8-bit buildCurveLut for the graph UI is unchanged in behaviour.
