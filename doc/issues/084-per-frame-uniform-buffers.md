# 084 · Every effect creates new uniform buffers and bind groups per frame

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Performance |
| Area | Effects / EffectRuntime |
| Verified | No — reported by reviewer |

## Problem
Each effect encode creates at least 2 new `GPUBuffer`s (`makeParamsBuf` / `makeMaskFlagsBuf`) plus a bind group every frame, causing allocation churn.

## Where
- `src/graphics/webgpu/EffectRuntime.ts` (`makeParamsBuf`, `makeMaskFlagsBuf`)

## Suggested fix
A pooled uniform ring buffer in `EffectRuntime` with dynamic offsets (sub-allocated per frame, reset at frame end).

## Done when
- No `createBuffer` calls per frame from effect encodes.


## Resolution
EffectRuntime recycles makeParamsBuf buffers through a per-size free list (returned in flushPendingDestroys, after submit; bounded at 128 per size) and serves makeMaskFlagsBuf from four constant buffers. Every encode/submit/flush path was checked to be synchronous, so a recycled buffer is never rewritten before its frame is submitted. No call-site changes; effect encodes no longer call createBuffer per frame. Bind groups are still created per encode (cheap; they reference per-frame textures).
