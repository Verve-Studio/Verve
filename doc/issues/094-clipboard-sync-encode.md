# 094 · Clipboard encode/decode runs synchronously on the main process

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Performance |
| Area | Electron main / Clipboard |
| Verified | No — reported by reviewer |

## Problem
`clipboard.readImage().toPNG()` and `nativeImage.createFromBuffer` are synchronous. PNG-encoding a 4K–8K clipboard image blocks main for hundreds of ms, and the result is then base64'd.

## Where
- `electron/main/ipc.ts:207-217`

## Suggested fix
Return raw `img.toBitmap()` plus its size as a `Uint8Array` (no PNG round trip; note BGRA order on Windows), or do the encode in the worker from [037](037-ml-in-main-process.md). Pairs with [054](054-base64-ipc-transfer.md).

## Done when
- Pasting an 8K image doesn't freeze the window chrome.


## Resolution
Clipboard IPC now moves nativeImage raw bitmaps (premultiplied BGRA, Skia N32) both ways: main uses toBitmap()/createFromBitmap() (plain copies, no PNG encode/decode on its event loop; write validates size). The renderer swizzles/(un)premultiplies in core/io/clipboardBitmap.ts. New clipboard:image-size IPC serves NewImageDialog's 'Clipboard' preset without transferring pixels. clipboard.readImage()'s own OS-format decode is unavoidable in main. Smoke-test copy/paste with external apps (Windows + macOS).
