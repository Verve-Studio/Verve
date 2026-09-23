# 028 · Open/save/transform errors are never shown to the user

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | Medium |
| Category | Stability |
| Area | Services / File ops, Canvas transforms |
| Verified | No — reported by reviewer |

## Problem
`openFromPath`, `handleSave` and Save a Copy have no try/catch, and callers use `void handleOpen()`. A corrupt `.verve` (`JSON.parse`), a PSD/EXR decode failure, or an IPC write failure becomes an unhandled rejection. `useAppLifecycle.ts:80-85` only surfaces `MemoryLimitError`. `useCanvasTransforms.ts:212, 329, 430, 730, 797` also only `console.error`, against CLAUDE.md's "surface the error" rule.

## Where
- `src/core/services/useFileOps.ts:313-1106, 1121-1261, 1263+`
- `src/core/services/useCanvasTransforms.ts:212, 329, 430, 730, 797`
- `src/core/services/useAppLifecycle.ts:80-85`

## Suggested fix
Wrap these in try/catch and call `showOperationError(...)`. Add a global `unhandledrejection` listener as a safety net that routes to `notificationStore`.

## Done when
- Opening a corrupt file, and a failed save (e.g. read-only target), both show an error dialog.


## Resolution
Open (every format, via the open queue), Save and Save a Copy are wrapped: failures show `showOperationError` with the file name / operation. Resize Image, AI Rescale, AI Restore, Rotate, Flip, Rotate Layer and Flip Layer now also show the error instead of only logging it. The global `unhandledrejection` handler in `useAppLifecycle` now reports any unhandled async failure through `notificationStore` (it used to handle only `MemoryLimitError`).
