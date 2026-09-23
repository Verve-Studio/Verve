# 042 · Preload exposes unrestricted `ipcRenderer`; renderer is unsandboxed

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Security |
| Area | Electron preload |
| Verified | Yes — confirmed in code during review |

## Problem
`contextBridge.exposeInMainWorld('electron', electronAPI)` gives page script `send` / `sendSync` / `invoke` / `on` / `removeAllListeners` on any channel, plus `process` info. Nothing in `src/` uses `window.electron`, so it's pure attack surface that bypasses the typed API. The renderer runs with `sandbox: false`, which isn't needed: the preload only uses `Buffer.from`, and plain `Uint8Array` clones through IPC fine.

## Where
- `electron/preload/index.ts:321-333`
- `electron/main/index.ts:94`

## Suggested fix
Remove the `electron` exposure and the non-isolated fallback branch, drop the `Buffer.from` wrappers in the preload, set `sandbox: true`, and remove the `window.electron` type declaration.

## Done when
- `window.electron` is undefined; the app works with `sandbox: true`.


## Resolution
The preload now exposes only the typed `api` (no `window.electron` raw `ipcRenderer`, no non-isolated fallback), drops the `@electron-toolkit/preload` import, and passes `Uint8Array`s instead of `Buffer.from(...)` (6 sites). `BrowserWindow` now uses `sandbox: true`. The built preload only `require`s `electron`. Not yet verified by launching the app; check that the window loads and file/AI features work.
