# 006 · Pen strokes on indexed8 layers render transparent

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Correctness |
| Area | Canvas pointer input / Tools |
| Verified | Yes — confirmed in code during review |

## Problem
The pen/touch coalesced batch in `handleMoveBatch` sets `renderer.deferFlush = true`, replays events, then calls `renderer.flushLayer(ctx.layer)` **without a palette**. The tools' own palette-aware flushes (`Pencil.tsx:1021`, `Eraser.tsx:121`) are no-ops under `deferFlush`. `Indexed8Strategy.uploadFull` expands with `palette ?? []`, so the layer renders transparent during pen strokes. For the Eraser nothing re-flushes afterwards, so it stays blank until some other flush.

## Where
- `src/core/services/useCanvasPointerInput.ts:135`

## Suggested fix
`renderer.flushLayer(ctx.layer, ctx.layer.format === 'indexed8' ? ctx.swatches : undefined)`. Fix together with [019](019-deferflush-stuck-after-throw.md) (try/finally in the same function).

## Done when
- Drawing with a pen (Pencil, Eraser) on an indexed8 document shows correct colours during and after the stroke.


## Resolution
The pen batch flush in `handleMoveBatch` now passes `ctx.swatches` when `ctx.layer.format === "indexed8"`.
