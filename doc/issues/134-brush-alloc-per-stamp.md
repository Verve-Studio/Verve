# 134 · Brush allocates dozens of objects per stamp

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Low |
| Category | Performance |
| Area | Tools / Brush |
| Verified | Yes |

## Problem
`applyStamp` builds a job object, colour round-trips and closures per stamp even for inert dynamics.

## Where
- `src/core/tools/Brush/stampEngine.ts`

## Suggested fix
Short-circuit inert colour dynamics (see 113).

## Done when
- Default brush stamps skip the colour round trip.

## Resolution
The per-stamp OKLab colour round trip (the largest per-stamp allocation cost on the default brush) is skipped when colour dynamics are inert (see 113). The JS-path per-pixel samplePixel allocation is addressed in 133.
