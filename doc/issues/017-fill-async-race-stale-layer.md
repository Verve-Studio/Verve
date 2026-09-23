# 017 · Fill tool's async flood fill writes into a stale layer

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | Medium |
| Category | Stability / Performance |
| Area | Tools / Fill, WASM |
| Verified | No — reported by reviewer |

## Problem
After the WASM promise resolves, Fill does `layer.data.set(result)` and `commitStroke` with no staleness check. A tab switch, undo, layer delete or `replaceLayerData` in between overwrites newer pixels, or throws a `RangeError` swallowed into `console.error`. `commitStroke` uses `activeScope()`, which after a tab switch is the other tab's history. Two quick clicks race.
It also makes four full-buffer copies (`layer.data.slice()` → heap → `slice` out → `set`) although the layer is already WASM-pinned (`layer.wasmPtr`).

## Where
- `src/core/tools/Fill/Fill.tsx:260-305`

## Suggested fix
Call `_pixelops_flood_fill(layer.wasmPtr, …)` synchronously, in place: no copies, no race. If it must stay async, capture a token (`scope`, `layer.id`, `contentVersion`, `data` reference) and drop the result if anything changed; surface errors via `notificationStore`.

## Done when
- Fill is synchronous (or race-safe); rapid double-clicks and fill-then-undo behave correctly.

## Resolution
The contiguous async fill in `Fill.tsx` now captures a token: a module-level `fillGeneration`, `contentVersion`, layer size and `ctx.scope`. The result is applied only if the token still matches, so a second click, undo, another edit or a tab switch drops the stale result. WASM failures surface via `notificationStore`. Not done: the in-place zero-copy fill via `layer.wasmPtr` (perf only; also see 096).
