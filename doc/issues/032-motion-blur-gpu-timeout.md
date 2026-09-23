# 032 · Motion Blur uses up to 999 bilinear taps in one pass

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | Medium |
| Category | Stability / Performance |
| Area | Effects / MotionBlur |
| Verified | No — reported by reviewer |

## Problem
A single pass of up to 999 bilinear taps is ~4,000 loads per pixel, a timeout risk on large documents.

## Where
- `src/core/effects/MotionBlur/filter-motion-blur.wgsl:56`

## Suggested fix
Cap the sample count and step with a larger stride, or use iterative doubling (log2(dist) passes of a few taps each).

## Done when
- Max-distance Motion Blur on an 8K document renders without device loss.


## Resolution
Distances up to 64 px are unchanged (one exact pass). Longer blurs run as two passes, box(⌈√L⌉, step 1) then comb(round(L/⌈√L⌉), step ⌈√L⌉), whose convolution is the same line blur (length within ~1.5%) at ~2√L taps: at L=999, 64 taps instead of 999. The shader takes `taps` + `spacing`; the intermediate is a doc-format scratch texture. Validated with naga.
