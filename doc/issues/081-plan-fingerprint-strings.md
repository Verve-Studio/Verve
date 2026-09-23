# 081 · Plan fingerprinting builds strings every frame, including no-op frames

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Performance |
| Area | GPU rendering |
| Verified | No — reported by reviewer |

## Problem
`computePlanFingerprint`, `planIsFlatLayersOnly` and `encodeSubPlan` each call `serializeAdjOp`, which runs `JSON.stringify` and `Float32Array` joins (palettes up to 1,024 floats), 2–3 times per frame per op.

## Where
- `src/graphics/webgpu/frame/RenderPlanExecutor.ts:874, 893, 1370`
- `src/graphics/webgpu/rendering/cacheKeys.ts`

## Suggested fix
Keep a per-op params version counter, or memoize the key on the op object (WeakMap).

## Done when
- No `JSON.stringify` in the per-frame path when nothing changed.


## Resolution
cacheKeys.serializeAdjOp memoizes per op object and per field value (WeakMap by identity; params/palettes are immutable once in a plan). ReduceColors / ColorDithering derive their palette Float32Array once per source-colour array, so plan entries are stable across frames and no JSON.stringify / 1024-float join runs on unchanged frames.
