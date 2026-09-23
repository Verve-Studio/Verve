# 059 · File-association IPC runs dozens of blocking child processes on the main thread

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | Electron main / File associations |
| Verified | No — reported by reviewer |

## Problem
`getState` runs ~16 sequential `execSync('reg query')`; `apply` runs ~64 `reg add/delete` plus a PowerShell cold start (`spawnSync`, 6 s timeout). The app freezes ~1–10 s when the preferences page opens or is applied. On macOS, `spawnSync lsregister -dump` output is far larger than the default 1 MB `maxBuffer`, so the check is almost certainly always false.

## Where
- `electron/main/fileAssociations.ts:56, 67, 104, 150`
- `electron/main/ipc.ts:580, 597`

## Suggested fix
Use async `execFile` / `spawn` with `Promise.all`, or write a single `.reg` file and import it with one async `reg import`. On macOS raise `maxBuffer` or stream-grep the output.

## Done when
- Opening the preferences page doesn't freeze the UI; macOS reports the association state correctly.


## Resolution
`electron/main/fileAssociations.ts` is fully asynchronous:
- `execFile` uses argument arrays, with no shell string parsing or manual escaping.
- Windows registry queries run in parallel; on apply, extensions register in parallel (each extension's keys in order), followed by the async SHChangeNotify.
- macOS streams `lsregister -dump` and stops at the first match (the old `spawnSync` hit its 1 MB `maxBuffer`, so the check was always false).
- Linux runs its `xdg-mime` queries in parallel.

The `fileAssoc:getState` / `fileAssoc:apply` handlers now await. Not exercised on a real registry.
