# 105 · Mouse input paints at half pressure

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Correctness |
| Area | Input pipeline |
| Verified | Yes |

## Problem
Pointer Events report `pressure = 0.5` for a pressed mouse; it is passed through raw. Pressure-driven size/opacity and the retouching tools' pressure strength (Blur, Sharpen, Smudge, Healing) run at half strength with a mouse.

## Where
- `src/core/services/useCanvas.ts:93, 118, 177`

## Suggested fix
Report pressure 1 for `pointerType === 'mouse'` (and pressure 0 buttons-up).

## Done when
- A mouse paints at full strength/size.

## Resolution
useCanvas maps pressure through pointerPressure(): a mouse reports 1 while a button is pressed (0 otherwise); pen/touch pressure is unchanged. Applies to single, raw and coalesced samples.
