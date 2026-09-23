# 019 · `deferFlush` can stick on after a tool throws, so painting stops working

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | Medium |
| Category | Stability |
| Area | Canvas pointer input |
| Verified | Partially — code path confirmed; no try/finally around the batch loop |

## Problem
In `handleMoveBatch`, if a tool throws inside the coalesced batch loop, `renderer.deferFlush` stays `true` forever. Every later `flushLayer` silently does nothing (`WebGPURenderer.ts:383`), so painting "stops working" until remount. Minor: the batch flushes only `ctx.layer`.

## Where
- `src/core/services/useCanvasPointerInput.ts:122-136`

## Suggested fix
`try { … } finally { renderer.deferFlush = false; renderer.flushLayer(…); ctx.render(); }`. Fix together with [006](006-indexed8-pen-batch-flush-no-palette.md) and [047](047-brush-pen-double-flush-full-upload.md).

## Done when
- A thrown error inside a tool's `onPointerMove` during a pen stroke doesn't disable subsequent painting.


## Resolution
`handleMoveBatch` wraps the coalesced loop in `try/finally`; `deferFlush` is always reset and the batch flush + render always run.
