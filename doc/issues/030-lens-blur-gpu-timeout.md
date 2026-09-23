# 030 · Lens Blur runs up to ~31k taps × 4 loads per pixel

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Stability / Performance |
| Area | Effects / LensBlur |
| Verified | No — reported by reviewer |

## Problem
Radius up to 100 gives ~31k kernel entries, each doing a manual 4-tap bilinear, although kernel offsets are integers so 3 of the 4 loads are wasted: ~125k loads per pixel, a GPU-timeout risk. The single-slot kernel cache also rebuilds the O(r²) kernel in JS every frame when two Lens Blur layers have different params.

## Where
- `src/core/effects/LensBlur/filter-lens-blur.wgsl:58-60`
- `src/core/effects/LensBlur/LensBlurEffect.tsx:20-60`

## Suggested fix
Use a single `textureLoad` per tap. Run large radii at 1/2 or 1/4 resolution with a scaled kernel, or switch to a separable hexagonal/ring bokeh approximation. Key the kernel cache by params (Map).

## Done when
- Lens Blur at radius 100 on a 4K document renders without device loss and at interactive speed when previewing.


## Resolution
Three changes:
- Integer kernel offsets now use a single `textureLoad` per tap instead of 4 (a 4× cut).
- Radii above 24 px run at `factor = ceil(r/24)` reduced resolution (box downsample → kernel at `r/factor` → bilinear upsample), so there are at most ~1.8k taps per pixel.
- The kernel cache is a keyed LRU (8 entries) instead of a single slot, so two Lens Blur layers no longer rebuild the kernel every frame.

Shader validated with naga.
