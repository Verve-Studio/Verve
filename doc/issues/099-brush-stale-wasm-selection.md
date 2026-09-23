# 099 · Brush WASM path clips to a stale selection mask

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Correctness |
| Area | Tools / Brush, WASM |
| Verified | Yes |

## Problem
`uploadSelMaskCanvas` caches the heap copy of the selection by array identity. `SelectionStore.invert()` and add/intersect/subtract (`applyMask`) mutate the same `Uint8Array` in place, so after Invert or Shift-add the WASM stamp kernels keep clipping to the old mask while the JS fallback clips to the new one.

## Where
- `src/wasm/brushStamp.ts:296-307`
- `src/core/store/selectionStore.ts:402-472`

## Suggested fix
Give the selection store a version counter bumped on every change and key the heap copy on it (or re-upload once per stroke).

## Done when
- Invert / extend a selection, then paint: paint stays inside the visible selection on every backend.

## Resolution
SelectionStore.notify() bumps an exported selectionRevision; the WASM brush's heap copy of the selection is keyed on (array identity, revision), so in-place edits (invert, add/subtract/intersect) re-upload the mask.
