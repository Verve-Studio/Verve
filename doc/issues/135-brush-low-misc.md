# 135 · Brush low-severity: spacing carry, tilt wrap, wet-edge format, SDF leak, batch flags

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Correctness / Stability |
| Area | Tools / Brush, WASM |
| Verified | Yes |

## Problem
- Leftover spacing can place a stamp behind the segment start.
- Tilt azimuth EMA doesn't wrap.
- Wet-edge darkening differs between rgba8 and rgba32f.
- `uploadSdf` never frees heap copies.
- Batch-open flags are not reset if a stamp append throws.
- `brush.noise` is unused.

## Where
- `src/core/tools/Brush/stampEngine.ts`
- `src/core/tools/Brush/Brush.tsx:474-476`
- `src/wasm/brushStamp.ts:316-327`

## Suggested fix
Clamp the carry; wrap tilt deltas; darken in linear light; free SDF copies via FinalizationRegistry; reset flags in finally.

## Done when
- Each item addressed.

## Resolution
Spacing carry is clamped to the segment's spacing (no stamp behind the segment start). Tilt azimuth smoothing follows the shortest arc. rgba8 wet-edge darkening scales linear light (matches rgba32f). SDF heap copies are freed by a FinalizationRegistry when their array is collected (also invalidating the baked-bitmap cache key, whose SDF pointers could be reused). The segment stamping loop is try/finally, so the batch flags always reset and the batch is flushed. The noise setting had no implementation in either render path; its non-functional UI section was removed (the data field stays).
