# 056 · Internal paths use slow base64 / PNG encodings where transfer stores would do

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | Tabs / History / Format remount / Clipboard |
| Verified | No — reported by reviewer |

## Problem
- Indexed8 tab switch, history jump and format remount build base64 via `String.fromCharCode(...Array.from(subarray))`.
- History jump encodes rgba8 layers and adjustment masks with synchronous `toDataURL("image/png")`, although `u8TransferStore` exists.
- Clipboard PNG base64 concatenates a string one byte at a time.

## Where
- `src/core/services/useTabs.ts:158-167`
- `src/core/services/useHistory.ts:194-240`
- `src/core/services/useFormatRemount.ts:54`
- `src/core/services/useClipboard.ts:50-53`

## Suggested fix
Use `u8TransferStore` refs for rgba8 / indexed8 / masks (tab-prefixed keys, see [016](016-async-transforms-wrong-tab.md)); send ArrayBuffers over IPC. Together with [005](005-indexed8-transform-stack-overflow.md), remove all `String.fromCharCode(...x)` spreads.

## Done when
- No PNG/base64 encoding on tab switch or history jump; history jump on a 4K document is visibly faster.


## Resolution
Three changes:
- **History jump** (`useHistory`) now hands rgba8 layers and adjustment masks to the remount through `u8TransferStore` refs instead of PNG data URLs via a 2D canvas. That is faster, and no longer lossy (the canvas round trip premultiplied alpha). f32/indexed8 refs there are now also tab-prefixed (`${tabId}:history:`).
- **Clipboard** exchanges PNG **bytes** over IPC both ways (`clipboardWriteImage(Uint8Array)`, `clipboardReadImage(): Uint8Array`); the per-byte string concatenation is gone. The New Image dialog's "clipboard size" reads dimensions from the bytes with `createImageBitmap`.
- The indexed8 base64 paths were removed earlier in 005.
