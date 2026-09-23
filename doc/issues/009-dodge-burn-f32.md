# 009 · Dodge/Burn corrupts rgba32f layers

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Correctness |
| Area | Tools / Dodge |
| Verified | No — reported by reviewer |

## Problem
Luminance is computed as `r/255` on linear floats, so it's ~0 and every pixel is treated as shadow. Writes use `Math.max(0, Math.min(255, Math.round(r*factor)))`, quantising HDR floats to integers. Dodge is only flagged `indexed8Unsupported`, so this runs on rgba32f.

Also, `origData` is a `Map<number, [r,g,b,a]>` that allocates a tuple per touched pixel.

## Where
- `src/core/tools/Dodge/dodgeBurn.ts:81-108`
- `src/core/tools/Dodge/Dodge.tsx:111`

## Suggested fix
Add an rgba32f branch: luminance from linear values (or gamma-encode for the tonal-range classification), apply the factor in float, no rounding or clamping to 255. Replace the `Map` with a per-stroke typed-array snapshot of the stroke bbox (or a canvas-sized typed array plus a "captured" bitset).

## Done when
- Dodge/Burn on rgba32f matches the rgba8 behaviour visually; HDR values > 1 survive.


## Resolution
Added an rgba32f branch to `dodgeBurnPixelOp`. It gamma-encodes the linear sample, classifies the tonal range and applies the factor in encoded space (matching rgba8 behaviour), then decodes back. There is no rounding and no upper clamp, so HDR survives. Not done: replacing the per-pixel `origData` Map with a typed array (perf only; a canvas-sized snapshot would cost more memory on large f32 docs than the Map).
