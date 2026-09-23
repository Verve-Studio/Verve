# 011 · Magic Wand (and Quick Select) mis-select on rgba32f

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Correctness |
| Area | Tools / MagicWand, QuickSelect |
| Verified | No — reported by reviewer |

## Problem
Magic Wand copies `layer.data` (floats) straight into a `Uint8Array`: every channel truncates to 0 or 1, so tolerance 32 selects essentially the whole contiguous region. Quick Select uses `f*255` without the transfer function (milder: wrong tolerance in shadows).

## Where
- `src/core/tools/MagicWand/MagicWand.tsx:87-99`
- `src/core/tools/QuickSelect/QuickSelect.tsx:76`

## Suggested fix
Convert via `linearToSrgbChannel(v) * 255` with clamping (`clampF32ToUint8` in `src/utils/pixelFormatConvert.ts`).

## Done when
- Magic Wand on an rgba32f gradient selects the same band as on the rgba8 version at the same tolerance.


## Resolution
Magic Wand now converts rgba32f layer data with `clampF32ToUint8` (sRGB transfer function) before the flood fill. Quick Select`s manual `f*255` loop was replaced with the same helper.
