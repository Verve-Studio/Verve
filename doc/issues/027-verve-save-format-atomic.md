# 027 · `.verve` save builds one giant JSON string and writes non-atomically

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Stability / Data integrity |
| Area | File I/O / Electron main |
| Verified | Partially — non-atomic `writeFile` confirmed; string-limit failure reported by reviewer |

## Problem
- rgba32f layers are stored as raw base64 (`f32ToBase64`): a 4096² float layer is ~341 MB of base64. Two such layers push `JSON.stringify(doc)` past V8's max string length, so save throws and the document can't be saved at all. On open, `readFile(path, 'utf-8')` fails the same way (`ERR_STRING_TOO_LONG`).
- Load uses `Uint8Array.from(atob(b64), c => c.charCodeAt(0))` (a callback per byte over hundreds of MB).
- `writeFile(path, data)` truncates the target first, so a crash or power loss mid-write destroys the user's existing file.
- userData JSON files (`prefs:save`, `recentFiles:add`, `dockLayout:save`, `paintBrushes:save`, `preferences.ts:95`) have the same non-atomic write; the load path swallows the parse error and silently resets them to defaults.

## Where
- `src/core/services/useFileOps.ts:142-160, 1172, 1248, 1305, 1375`
- `src/core/services/useGpuLayerInit.ts:218, 241`
- `electron/main/ipc.ts:120-126`, ~236-326
- `electron/main/preferences.ts:95`

## Suggested fix
1. **Now:** write to `path + '.tmp'` then `rename` over the target, for `.verve` and all userData JSON. Log (and back up) unparseable prefs instead of silently resetting.
2. **Then:** switch `.verve` to a binary container (zip or header + layer chunks), sent to main as `Uint8Array`s (or streamed). Keep reading the current JSON format for existing files. (Reading old files is not a migration, just a loader.)

## Done when
- Killing the app mid-save leaves the previous file intact.
- A document with four 4K rgba32f layers saves and re-opens.


## Resolution
Both parts are done.

1. **Atomic writes.** New `electron/main/atomicWrite.ts` (`writeFileAtomic`: temp file in the same directory, then rename, retrying on Windows EPERM/EBUSY). It is used for `.verve` saves, image exports, JSON/palette/brush/preset files, recent files, dock layout, preferences and imported colour profiles. An unparseable `prefs.json` is now copied to `prefs.json.corrupt-<ts>` instead of being silently overwritten.
2. **Binary container.** New `src/core/io/verveContainer.ts` ("VERVEPK1" magic + JSON header + 8-byte-aligned blobs). rgba32f and indexed8 layer data are stored as raw blobs referenced by `"blob:N"`, the whole file travels over IPC as `Uint8Array` (`openverveFile` / `saveverveFile` now take/return bytes), and loading hands blobs to layer init through the transfer stores. Legacy JSON `.verve` files still open (detected by the missing magic). Their base64 decode in `useGpuLayerInit` is now a plain loop. Round-trip verified in Node.

Note: older Verve builds cannot open files saved in the new container.
