# 137 · Dead painting code (unused primitives, newPixelLayerRef)

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Maintainability |
| Area | Tools / primitives, Canvas |
| Verified | Yes |

## Problem
`drawThickLine`, `drawAALine`, `eraseLine`, `drawLine` and private helpers in `primitives.ts` have no callers (and carry the same Bresenham hazard); `newPixelLayerRef` is never assigned but scanned every frame.

## Where
- `src/core/tools/_shared/primitives.ts:124-636`
- `src/ux/main/Canvas/Canvas.tsx`, `useToolContext.ts`

## Suggested fix
Delete them.

## Done when
- No unused painting helpers remain.

## Resolution
Deleted the unused primitives (drawLine, drawAALine, eraseLine, stampCircle, drawAAThickSegment, drawThickLine) and the never-assigned newPixelLayerRef (Canvas, plan builders, useToolContext / useCanvasPointerInput params).
