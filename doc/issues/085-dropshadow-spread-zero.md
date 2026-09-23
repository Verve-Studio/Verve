# 085 · DropShadow runs dilate passes even when spread is 0

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Performance |
| Area | Effects / DropShadow |
| Verified | No — reported by reviewer |

## Problem
The dilate H+V passes run even when spread is 0: two wasted full-resolution passes.

## Where
- `src/core/effects/DropShadow/DropShadowEffect.tsx`

## Suggested fix
Skip the dilate passes when `spread === 0`.

## Done when
- With spread 0, only blur and composite passes run.


## Resolution
With spread 0 both dilate passes are skipped: drop-shadow-blur-h gained a readAlpha flag (spare pad field; Bevel/InnerShadow pass 0) so the first blur pass reads the layer alpha directly. Spread 0 + softness 0 runs a single radius-0 dilate (alpha → .r). Pass encoding factored into one helper; also benefits Glow.
