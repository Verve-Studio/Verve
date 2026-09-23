# 128 · Airbrush build-up doesn't render with a pen

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Input pipeline / Brush |
| Verified | Yes |

## Problem
The batch path hands tools `{...ctx, render: noopRender}`; Brush stores it for build-up ticks, which then never render.

## Where
- `src/core/services/useCanvasPointerInput.ts:146-149`
- `src/core/tools/Brush/Brush.tsx:386-411, 512-514`

## Suggested fix
Keep the real `render` in the context; suppress renders during the batch at the renderer level.

## Done when
- Holding a pen still with build-up visibly builds paint.

## Resolution
The batch passes the real ToolContext (render included) instead of a copy with a no-op render — doRender already coalesces to one rAF per frame — so Brush build-up ticks that reuse the stored context render again with a pen.
