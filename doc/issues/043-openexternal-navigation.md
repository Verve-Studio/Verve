# 043 · `shell.openExternal` accepts any URL; navigation is unrestricted

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | Medium |
| Category | Security |
| Area | Electron main |
| Verified | No — reported by reviewer |

## Problem
Every `window.open` / `target=_blank` URL goes to `openExternal` unchecked: `file://`, `ms-msdt:`, `search-ms:`, UNC paths etc. There's no `will-navigate` handler, so a dropped file or link can navigate the main window away from the app.

## Where
- `electron/main/index.ts:117-120`

## Suggested fix
Allow only `https:` (and `mailto:` if needed) via `new URL(url).protocol` before `openExternal`. Add `app.on('web-contents-created')` → `will-navigate` → `preventDefault()` unless the target is the app's own URL. Consider `session.setPermissionRequestHandler` denying everything.

## Done when
- `window.open('file:///C:/Windows')` is ignored; dropping a URL onto the window doesn't navigate away.


## Resolution
`setWindowOpenHandler` only passes `http:`, `https:` and `mailto:` URLs to `shell.openExternal` (`isSafeExternalUrl`). A `will-navigate` handler blocks navigating the main window anywhere except the app's own URL (dev server or bundled `renderer/index.html`). The session's permission request handler denies all permissions.
