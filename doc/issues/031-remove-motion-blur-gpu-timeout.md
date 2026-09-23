# 031 · Remove Motion Blur: GPU-timeout risk and per-encode full-res allocations

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Stability / Performance |
| Area | Effects / RemoveMotionBlur |
| Verified | No — reported by reviewer |

## Problem
8–15 iterations, each with 2 PSF passes of up to 999 samples × 4 loads: up to ~120k loads per pixel. It also allocates four full-resolution `rgba16float` textures on every encode (~512 MB at 16 MP) and frees them after submit.

## Where
- `src/core/effects/RemoveMotionBlur/RemoveMotionBlurEffect.tsx:61, 77-80`
- `src/core/effects/RemoveMotionBlur/filter-rmb-psf.wgsl:51`

## Suggested fix
Cap or downsample the PSF (e.g. fixed 32–64 taps with a stride). Keep the four textures in a module-level cache with grace-period eviction. Consider running only on commit rather than live, or preview at reduced resolution.

## Done when
- Max-length Remove Motion Blur on a 16 MP image completes without device loss; no per-frame texture allocation while idle.


## Resolution
The PSF pass samples at most 32 bilinear taps spread evenly over the same `distance` span (new `taps` field in `RmbPsfParams`; identical to before when distance ≤ 32). That is roughly a 30× cut at the maximum distance. The four rgba16float intermediates now live in a `TextureSetCache` keyed by size (grace-period eviction) instead of being allocated on every encode. Shader validated with naga. Not done: running it only on commit.
