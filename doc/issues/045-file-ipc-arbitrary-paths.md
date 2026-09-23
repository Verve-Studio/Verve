# 045 · Generic file IPC reads/writes any path the renderer supplies

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | Medium |
| Category | Security |
| Area | Electron main / IPC |
| Verified | No — reported by reviewer |

## Problem
`file:writeJson`, `file:openverve` / `saveverve`, `file:readFileBase64`, `file:exportImage`, `file:readPalette` / `writePalette` and brush-file handlers accept arbitrary paths. Combined with [042](042-preload-raw-ipcrenderer-sandbox.md), any renderer compromise (e.g. a crafted PSD/SVG exploiting a decoder) becomes arbitrary filesystem read/write (e.g. into Startup folders).

## Where
- `electron/main/ipc.ts:79-81, 95-101, 120-128, 199-205, 279-285, 319-325`

## Suggested fix
Keep a main-side allowlist of paths granted by `showOpenDialog` / `showSaveDialog`, recent files, the startup / `open-file` path and linked-layer sources; reject anything else. Check extensions in write handlers.

## Done when
- IPC calls with a path never granted by a dialog or recent-files list are rejected.


## Resolution
New `electron/main/fileAccess.ts` guards the file IPC handlers.
- **Writes** are allowed only for the handler's own extensions: `.verve`, `.json`, `.palette`, `.vbrush`, `.pxbrush`, and image/PDF export formats. A renderer can no longer drop `.exe`/`.bat`/`.lnk`/`.js` files anywhere.
- **Reads** require a supported extension, or a file the user picked in an open dialog this session. All open dialogs now register their picks, so "All Files" picks keep working.

We chose file type over a strict dialog-granted allowlist, because drag & drop, recent files, linked-layer sources and remembered export paths also supply paths and would have broken.
