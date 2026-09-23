# 098 · Eraser with Anti-alias off freezes the app

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | Critical |
| Category | Stability |
| Area | Tools / Eraser, primitives |
| Verified | Yes — confirmed by reading the loop |

## Problem
`bresenham` terminates only when `x === x1 && y === y1`. The eraser's smoothed quadratic path produces fractional segment endpoints (`tipX = (lastCtrl.x + stabX) * 0.5`), and with Anti-alias off `eraseThickLine` passes them to `bresenham`, which then never reaches the end point and loops forever. A malformed pixel brush (width 0 → NaN coordinates) hits the same loop.

## Where
- `src/core/tools/_shared/primitives.ts:94-122`
- `src/core/tools/Eraser/eraseStroke.ts:307-347, 385-413`
- `src/core/tools/Eraser/Eraser.tsx:215-235`

## Suggested fix
Round endpoints in the non-AA eraser branches; make `bresenham` defensive (round inputs, reject non-finite, bound iterations to `max(|dx|,|dy|)+1`). Validate pixel-brush dimensions on load.

## Done when
- Dragging the eraser with Anti-alias off never hangs; `bresenham` cannot loop forever on any input.

## Resolution
bresenham now rounds its endpoints, returns on non-finite input and bounds its loop to max(|dx|,|dy|)+1 steps, so no caller can hang it (the eraser's fractional smoothed endpoints did). Pixel brushes are validated (positive integer size, payload exactly w×h×4) when loading the user store, importing and opening documents, and getBrushPixels always returns a w×h×4 buffer.
