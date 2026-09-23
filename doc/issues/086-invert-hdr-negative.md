# 086 · Invert produces negative values for HDR input

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Correctness |
| Area | Effects / ColorInvert |
| Verified | No — reported by reviewer |

## Problem
`1 - x` goes negative for HDR values > 1, and later effects receive negative values.

## Where
- `src/core/effects/ColorInvert/invert.wgsl:35`

## Suggested fix
Clamp the result to ≥ 0 (or define HDR invert explicitly, e.g. invert in a tone-mapped domain). Document the chosen behaviour.

## Done when
- Invert on an HDR image produces no negative values.


## Resolution
invert.wgsl clamps to [0, 1] before inverting (HDR highlights invert to black; never negative) and, for linear input (MaskFlags.inputIsLinear), inverts in the sRGB-encoded domain so float docs match the 8-bit result. Behaviour documented in the shader.
