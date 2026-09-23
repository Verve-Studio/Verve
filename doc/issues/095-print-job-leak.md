# 095 · A print job can leak its window and temp directory

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Stability |
| Area | Electron main / Printing |
| Verified | No — reported by reviewer |

## Problem
If `webContents.print`'s callback never fires (known with some drivers or cancelled spoolers), the promise never resolves: the hidden BrowserWindow and temp directory leak, and the renderer's print dialog hangs.

## Where
- `electron/main/ipc.ts:776-792`

## Suggested fix
Race the print against a timeout (e.g. 120 s); on timeout destroy the window, clean up the temp dir, and reject so the renderer can close its dialog.

## Done when
- Cancelling at the OS spooler never leaves the print dialog hanging.


## Resolution
printer:print races webContents.print against a 120 s deadline; on timeout it destroys the hidden window, removes the temp dir and resolves { success: false, error } so the Print Preview dialog shows the error and stops waiting. Settles exactly once; late callbacks are ignored; window destroy is guarded with isDestroyed().
