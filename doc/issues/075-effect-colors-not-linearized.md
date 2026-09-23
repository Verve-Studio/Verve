# 075 · Effect colour params are passed as `/255` sRGB into linear documents

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Effects / DropShadow, InnerShadow, InnerGlow, Outline, Clouds, ColorKey |
| Verified | No — reported by reviewer |

## Problem
Colours are uploaded as sRGB/255 regardless of document format. On rgba32f, shadows and outlines come out too light and Color Key keys the wrong colours (compared against linear `src`).

## Where
- `src/core/effects/DropShadow/DropShadowEffect.tsx:340`
- `src/core/effects/InnerShadow/InnerShadowEffect.tsx:247`
- `src/core/effects/InnerGlow/InnerGlowEffect.tsx:51`
- `src/core/effects/Outline/OutlineEffect.tsx:174`
- `src/core/effects/Clouds/filter-clouds.wgsl:95-100`
- `src/core/effects/ColorKey/ColorKeyEffect.tsx:66`, `ck.wgsl:87`

## Suggested fix
Gamma-decode the colour on the CPU when `dstTex.format === "rgba32float"`. Consider a shared helper in `effects/_shared` (`colorForTarget(rgb, format)`).

## Done when
- A black drop shadow on an rgba32f document is visually identical to the rgba8 version.


## Resolution
New effects/_shared/effectColor.ts (colorForTarget, isLinearTarget). DropShadow, Glow, InnerShadow, InnerGlow and Outline gamma-decode their colour for linear targets. ck.wgsl encodes linear pixels to sRGB before the HSV key comparison (MaskFlags.inputIsLinear). Clouds passes outputIsLinear and decodes its sRGB cloud colour; HDR source values are no longer clipped at 1.
