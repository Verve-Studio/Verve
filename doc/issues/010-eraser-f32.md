# 010 · Eraser is broken on rgba32f

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Correctness |
| Area | Tools / Eraser |
| Verified | No — reported by reviewer |

## Problem
- Alpha mode writes `Math.round(ea*(1-incr))` with `ea` in 0–1, so soft/partial erasing snaps alpha to 0 or 1.
- RGB (erase-to-background) mode lerps linear floats (0–1) toward `secR/G/B` bytes (0–255) and rounds, producing values around 255 (blown-out HDR).

## Where
- `src/core/tools/Eraser/eraseStroke.ts:66-81`

## Suggested fix
Branch on `rgba32f`: unrounded float alpha; lerp toward `srgbColorToLinearF32(secondaryColor)`.

## Done when
- A soft eraser at 50% opacity on rgba32f produces smooth partial alpha; background-colour erase produces the correct linear colour.


## Resolution
`erasePixelOp` has an rgba32f branch: alpha mode scales float alpha with no rounding; RGB mode lerps toward the secondary colour gamma-decoded with `srgbToLinearChannel`. indexed8 goes through its own path in `Eraser.tsx`, so it is unaffected.
