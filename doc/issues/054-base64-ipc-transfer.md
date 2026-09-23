# 054 · File read, export, clipboard and print move image bytes as base64 strings

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | High |
| Category | Performance / Stability |
| Area | Electron IPC / File I/O |
| Verified | No — reported by reviewer |

## Problem
Each transfer makes 4–5 full copies (bytes → binary string → base64 at 1.33× → IPC copy → decode), all on the JS heap. A 300 MB EXR/PSD/TIFF open or export means GBs of transient garbage and long GC pauses, and can hit V8's max string length (`RangeError: Invalid string length`).

## Where
- `electron/main/ipc.ts:145-148` (`file:readFileBase64`), `:150-153` (`file:exportImage`), `:207-217` (clipboard), `:539` (print `pngBase64`)
- `electron/main/colorProfiles.ts:146, 157`
- `src/core/services/useExportOps.ts:74-84` (`bytesToBase64`)
- `src/core/io/imageLoader.ts:273+` (`atob` loops)
- `src/App.tsx:273`, `src/core/services/useFileOps.ts:319, 522, 628`

## Suggested fix
Send `Uint8Array` both ways: `ipcMain.handle` can return a `Buffer` (renderer receives `Uint8Array`), and the renderer can pass a `Uint8Array` to write handlers. Delete `bytesToBase64` / `atob` from these paths. For clipboard use `nativeImage.createFromBuffer(Buffer)` directly (see also [094](094-clipboard-sync-encode.md)).

## Done when
- No base64 encoding/decoding of image bytes on the open/export/clipboard/print paths.


## Resolution
Reads: the new `file:read` IPC (`window.api.readFile`) returns raw bytes and replaces `readFileBase64` for every caller (open image/PSD/EXR, open as layer, linked layers, spritesheet frames, frame content, ICC browse). The new `loadImageBytes(bytes, mime)` decodes straight from bytes (browser formats via an object URL, the same `<img>` path as before); `loadImagePixels(dataUrl)` is now a thin wrapper for embedded data URLs. TIFF passes an exact-range ArrayBuffer to UTIF.

Writes: `exportImage` accepts raw bytes or base64, so the raw-byte encoders (EXR, TIFF32, HDR, PSD, DDS, GIF) no longer build base64; only canvas-encoded PNG/JPEG data URLs still pass base64. Clipboard and print are tracked in 094 / 056. Needs a manual open/export smoke test in the app.
