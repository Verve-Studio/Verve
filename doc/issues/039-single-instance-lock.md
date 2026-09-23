# 039 · No single-instance lock

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | Medium |
| Category | Stability |
| Area | Electron main |
| Verified | No — reported by reviewer |

## Problem
No `app.requestSingleInstanceLock()` / `second-instance` handler. On Windows and Linux, opening an associated file while Verve runs launches a second app (second GPU process, WebGPU device, duplicate ML sessions). Both instances race on the userData JSON files. The file-association registration (`fileAssociations.ts:93`, `"%1"`) makes this the normal path.

## Where
- `electron/main/index.ts:129-169`

## Suggested fix
Take the lock at startup and quit if not acquired. On `second-instance`, extract the file path from `argv`, focus the existing window and `webContents.send('app:open-file', path)`.

## Done when
- Double-clicking a `.verve` file while Verve is open opens it as a tab in the existing window.


## Resolution
`electron/main/index.ts` takes `app.requestSingleInstanceLock()` at startup; a second launch exits immediately. The running instance handles `second-instance`: it restores/focuses the window, extracts the file path from the new argv (same parser as the startup file) and sends `app:open-file`, which the renderer already handles.
