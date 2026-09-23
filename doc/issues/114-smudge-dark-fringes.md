# 114 · Smudge / Liquify / Healing pull black from transparent pixels

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Brush smudge, Liquify, Healing |
| Verified | Yes |

## Problem
Brush smudge pickup averages RGB without alpha weighting; Liquify interpolates straight alpha; Healing's tone match sums RGB of transparent pixels.

## Where
- `src/core/tools/Brush/stampEngine.ts:280-305`
- `src/core/tools/Liquify/Liquify.tsx:135-169`
- `src/core/tools/HealingBrush/HealingBrush.tsx:188-205`

## Suggested fix
Premultiplied averaging / interpolation; weight tone sums by pixel alpha.

## Done when
- No dark fringes near transparency.

## Resolution
Brush smudge pickup averages premultiplied (transparent taps lower alpha only) and the carry mix weights colour by each side's alpha. Liquify's bilinear sample interpolates premultiplied colour (taps fetched once each). Healing's tone match weights destination and source sums by their own pixel alpha.
