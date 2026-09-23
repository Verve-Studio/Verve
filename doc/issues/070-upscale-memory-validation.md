# 070 · Upscale IPC doesn't validate target size and makes extra full-size copies

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance / Stability |
| Area | Electron main / ML Upscale |
| Verified | No — reported by reviewer |

## Problem
Peak memory is `upRgba` (upW·upH·4) + `alphaUp` (upW·upH) + the resized output + `Buffer.from(result)` (another full copy) + the IPC serialization copy: ~3–4× a 256 MB buffer for a 2k² ×4 upscale, all in the main process heap. `targetWidth` / `targetHeight` aren't validated.

## Where
- `electron/main/upscale.ts:357, 371, 465, 524`

## Suggested fix
- Validate width, height and target as positive integers within a limit.
- Return `result` directly (no `Buffer.from` copy).
- Write alpha straight into `upRgba` instead of a separate `alphaUp`.
- Resample tile by tile into the target when the target is smaller than native scale.

## Done when
- Peak main-process memory during a 2k² ×4 upscale drops substantially; invalid sizes are rejected.

## Resolution
Done:
- Sizes are validated: source and target sides must be integers from 1 to 32768 (`MAX_UPSCALE_DIM`).
- The result is returned without the extra `Buffer.from()` copy (037).
- Alpha is bilinear-resized straight into the output buffer (`fillAlphaBilinear`) instead of via separate `alphaIn` / `alphaUp` buffers.
- The whole upscale now runs in the ML worker process, not the main process.

Not done: resampling tile-by-tile into a smaller target instead of materialising the native-scale buffer first.
