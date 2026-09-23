# 005 · Indexed8 Resize/Rotate/Flip silently fail above ~1024²

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Correctness |
| Area | Services / Canvas transforms |
| Verified | Yes — confirmed in code during review |

## Problem
`btoa(String.fromCharCode(...buffer))` spreads the whole layer (1 byte per pixel) as function arguments. Around 1M pixels this throws `RangeError`. The `catch` only calls `console.error`, so the operation silently does nothing.

## Where
`src/core/services/useCanvasTransforms.ts:179, 497, 593, 673, 765`

## Suggested fix
Pass indexed data through `u8TransferStore` with an indexed ref (as the f32 path uses `f32TransferStore`) instead of base64. If base64 must remain temporarily, encode in chunks (see [056](056-slow-internal-encodings.md)). Surface failures via `showOperationError` (see [028](028-file-and-operation-errors-not-surfaced.md)).

## Done when
- Resize Image, Rotate 90/180 and Flip work on a 4096² indexed8 document.


## Resolution
Added a `data:raw/indexed8-ref;id=` layer-data format (consumed from `u8TransferStore` in `useGpuLayerInit`). Every in-app indexed8 producer now uses it instead of base64: Resize Image, Canvas Size, Crop, Rotate, Flip (`useCanvasTransforms`), format remount, history jump, and tab backgrounding. No `String.fromCharCode(...whole buffer)` spreads remain. Surfacing errors to the user is tracked in 028.
