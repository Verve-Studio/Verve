# 106 · Sharpen clips HDR; Healing ignores the selection; hard selections in Clone/Dodge

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Correctness |
| Area | Tools / retouching |
| Verified | Yes |

## Problem
- Sharpen clamps rgba32f results to 1.
- Healing never applies the selection mask.
- Clone Stamp (`blendPixelOver`) and Dodge/Burn treat any non-zero mask value as fully selected, so feathered selections get hard edges.

## Where
- `src/core/tools/Sharpen/Sharpen.tsx:77, 141-146`
- `src/core/tools/HealingBrush/HealingBrush.tsx:62-247`
- `src/core/tools/_shared/primitives.ts:219`
- `src/core/tools/Dodge/dodgeBurn.ts:64`

## Suggested fix
Clamp float only below; weight healing by the selection; scale opacity/coverage by mask/255.

## Done when
- HDR survives Sharpen; Healing respects selections; feathered selections fade in Clone/Dodge.

## Resolution
Sharpen clamps rgba32f only below (HDR kept). Healing weights each pixel by the selection (brushSelection/selectionWeight). Soft selections scale the effect everywhere: blendPixelOver scales deposit, cap and silhouette by mask/255, the five C++ stamp-kernel selection checks scale coverage by mask/255 (JS and WASM stay consistent), and Dodge/Burn scales coverage.
