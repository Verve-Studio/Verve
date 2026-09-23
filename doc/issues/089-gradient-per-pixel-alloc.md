# 089 · Gradient allocates a tuple per pixel

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Performance |
| Area | Tools / Gradient |
| Verified | No — reported by reviewer |

## Problem
`lerpColor` allocates a 4-tuple for every canvas pixel (`Gradient.tsx:298`), and rgba32f runs 3 `pow` calls per pixel.

## Where
- `src/core/tools/Gradient/Gradient.tsx:298`

## Suggested fix
Inline the lerp and precompute a 1D LUT over t (e.g. 4096 entries), in the target colour space.

## Done when
- Gradient on an 8K canvas completes without per-pixel allocations.


## Resolution
renderGradient builds one 4096-entry LUT per gradient in the layer's encoding (linear floats for rgba32f, rounded sRGB bytes for rgba8); the per-pixel loop does an indexed read. No per-pixel tuple allocation and no per-pixel pow().
