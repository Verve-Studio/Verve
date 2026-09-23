# 113 · Brush colour pipeline clamps / mis-encodes HDR

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Brush |
| Verified | Yes |

## Problem
`oklch.ts` treats channels > 1 as already linear while the rest of the code uses the power-law extension; colour jitter clamps L to [0,1]; the per-stamp colour round trip runs even when all colour dynamics are inert, clamping HDR primaries. Per-stroke colour jitter is never resolved.

## Where
- `src/core/tools/Brush/oklch.ts:106-117`
- `src/core/tools/Brush/colorJitter.ts:86`
- `src/core/tools/Brush/stampEngine.ts:165-170, 572-577`

## Suggested fix
Use the shared transfer functions; skip resolution when colour dynamics are inert; don't clamp L above 1; resolve per-stroke jitter once per stroke.

## Done when
- HDR colours paint unchanged with inert jitter; per-stroke jitter works.

## Resolution
oklch.ts uses the power-law transfer function throughout (no identity branch above 1), so encode/decode match the stamp path's decode. Colour-jitter lightness is never clamped below the input's own L (HDR preserved). Colour resolution is skipped when every colour dynamic is inert (colorDynamicsInert), and per-stroke jitter is resolved once on the first stamp (strokeColorResolved).
