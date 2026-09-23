# 071 · Brush smudge on rgba32f gamma-decodes twice

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Brush |
| Verified | No — reported by reviewer |

## Problem
`sampleOneLayerFloat` returns linear values for rgba32f. They're mixed in OKLab as if sRGB (`mixSrgbInOklab`), then pushed through `srgbToLinearChannel` again. Smudging on HDR layers progressively darkens.

## Where
- `src/core/tools/Brush/stampEngine.ts:253-257, 732, 821`

## Suggested fix
Gamma-encode the sample (`linearToSrgbChannel`) when the layer is rgba32f before OKLab mixing, or add a linear-input variant of the mixer.

## Done when
- Smudging back and forth on a mid-grey rgba32f layer doesn't darken it.


## Resolution
sampleOneLayerFloat now sRGB-encodes rgba32f samples (linearToSrgbChannel), so the OKLab carry mix and the single decode at stamp time see one consistent encoding.
