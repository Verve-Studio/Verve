# 067 · Expensive 2D kernels in Bilateral, Color Key dilation and Gaussian

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | Effects |
| Verified | No — reported by reviewer |

## Problem
- **Bilateral** (`filter-bilateral.wgsl:42`): r ≤ 20 gives 1,681 taps with 2 `exp` each.
- **Color Key dilation** (`ck.wgsl:99`): up to 1,681 neighbours, each running a full `keyedAlpha` / HSV conversion.
- **Gaussian** (`filter-gaussian-h.wgsl:40`): r ≤ 250 with `exp` per tap.

## Where
- `src/core/effects/**/filter-bilateral.wgsl:42`
- `src/core/effects/ColorKey/ck.wgsl:99`
- `src/core/effects/GaussianBlur/filter-gaussian-h.wgsl:40`

## Suggested fix
Precompute weights into a uniform/storage array; compute keyed alpha once into a texture then run a separable H+V min-filter for dilation; downsample for large Gaussian radii.

## Done when
- Max-parameter Bilateral / Color Key / Gaussian on 4K stay interactive.


## Resolution
Three shaders changed:
- **Gaussian** (h and v): no per-tap `exp()`. Weights come from a multiplicative recurrence (g(x+1) = g(x)·ratio, ratio·= e1²), and each weight serves both ±x taps (the shared `filter-gaussian-*` shaders benefit every effect that uses them).
- **Bilateral:** one `exp()` per tap instead of two, and a circular window (the square's corners were ~21% of the taps).
- **Color Key:** dilation stops as soon as the running minimum reaches 0.

All validated with naga. Remaining (larger restructure, not done): making Color Key dilation a true separable H+V min-filter over a precomputed keyed-alpha texture, and downsampling very large Gaussian radii.
