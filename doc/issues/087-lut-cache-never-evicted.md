# 087 · LUT GPU cache is never evicted

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Memory |
| Area | Effects / LUT |
| Verified | No — reported by reviewer |

## Problem
`evictLut` in `core/lut/lutGpu.ts` is never called, so the LUT GPU cache grows without bound (small in practice).

## Where
- `src/core/lut/lutGpu.ts`

## Suggested fix
Call `evictLut` when a LUT adjustment layer is removed, or evict LUTs not referenced by any plan (same mark-and-sweep as [021](021-standalone-effect-cache-leak.md)).

## Done when
- Removing LUT adjustments frees their GPU textures.


## Resolution
lutGpu bundles track lastUsed; entries idle for 60 s are destroyed by a rate-limited sweep (every 5 s) run from ensureLutOnGpu and from RenderPlanExecutor.flushPendingDestroys (sweepIdleLuts). Time-based rather than store-driven because display/proof LUT ids aren't in lutStore. A removed LUT adjustment's textures are freed within ~a minute.
