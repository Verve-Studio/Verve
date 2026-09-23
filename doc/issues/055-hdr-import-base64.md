# 055 · Single-layer HDR import does a needless base64 round trip

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance / Stability |
| Area | Services / File ops |
| Verified | No — reported by reviewer |

## Problem
The single-layer HDR path encodes the whole Float32 buffer into one binary string 8K chars at a time, then `btoa`, then decodes again via the slow `atob` path. An 8K HDR (~566 MB) exceeds the max string length and throws. The multi-layer EXR path right above (line 541) already uses `f32TransferStore`.

## Where
- `src/core/services/useFileOps.ts:684-695`

## Suggested fix
`f32TransferStore.set(`${newId}:layer-0`, f32Data)` with a `data:raw/f32-ref;id=` entry, like the multi-layer path.

## Done when
- Opening an 8K HDR/EXR single-layer image works and avoids base64.


## Resolution
The single-layer HDR import in `useFileOps` now stores the Float32 pixels in `f32TransferStore` under a unique key and references them as `data:raw/f32-ref`, like the multi-layer EXR path. The chunked binary-string + `btoa` + `atob` round trip is gone.
