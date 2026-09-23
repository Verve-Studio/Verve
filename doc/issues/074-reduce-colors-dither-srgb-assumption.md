# 074 · Reduce Colors and Color Dithering assume sRGB input

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Effects / ReduceColors, ColorDithering |
| Verified | No — reported by reviewer |

## Problem
`rc.wgsl:83, 95` and `dither.wgsl:115, 134` always decode `src` from sRGB and write sRGB output; their `MaskFlags` struct doesn't declare `inputIsLinear`. On rgba32f docs the input is decoded twice and sRGB values are written into a linear buffer. `ReduceColorsPanel.tsx:49` converts float → byte with `v*255`, violating the CLAUDE.md transfer-function rule.

## Where
- `src/core/effects/ReduceColors/rc.wgsl:83, 95`
- `src/core/effects/ReduceColors/ReduceColorsPanel.tsx:49`
- `src/core/effects/ColorDithering/dither.wgsl:115, 134`

## Suggested fix
Read `maskFlags.inputIsLinear` (add it to the WGSL struct, matching the JS packing) and branch encode/decode accordingly. Use `linearToSrgbChannel` in the panel.

## Done when
- Reduce Colors / Color Dithering on rgba32f look the same as on the rgba8 version of the image.


## Resolution
rc.wgsl and dither.wgsl declare MaskFlags.inputIsLinear (already packed by makeMaskFlagsBuf) and skip the sRGB decode/encode on linear input. The panel's float→byte conversion was already fixed in 069 (linearToSrgbChannel).
