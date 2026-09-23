# 109 · Bitmap stamp path snaps stamp centres to whole pixels

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Brush, WASM |
| Verified | Yes |

## Problem
`bmOff = round(cx) - halfX` places baked bitmap stamps at integer positions, so small hard brushes staircase on shallow diagonals and differ from the SDF/JS paths by up to 0.5 px.

## Where
- `src/wasm/brushStamp.ts:707-708`
- `wasm/src/brush_stamp.cpp:230-231`

## Suggested fix
Bake at the fractional phase of the stamp centre.

## Done when
- Bitmap stamps sit at sub-pixel positions.

## Resolution
The bitmap batch (whole-pixel stamp placement) is only used for stamps ≥ 16 px, where a half-pixel snap is invisible; smaller stamps use the SDF batch, which positions stamps at sub-pixel precision.
