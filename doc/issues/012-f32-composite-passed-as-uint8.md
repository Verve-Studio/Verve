# 012 · Content-Aware Fill / Generate Palette receive Float32 data as bytes

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Correctness |
| Area | WASM boundary / Services |
| Verified | No — reported by reviewer |

## Problem
`rasterizeComposite` returns a `Float32Array` for rgba32f documents. The callers pass it to WASM wrappers expecting a `Uint8Array`; `HEAPU8.set(Float32Array)` converts element-wise, so 0.0–0.99 → 0 and 1.0 → 1. Content-Aware Fill produces a black fill; Generate Palette a near-black palette.

## Where
- `src/core/services/useContentAwareFill.ts:128`
- `GeneratePaletteDialog.tsx:148`

## Suggested fix
Convert at the boundary like `ReduceColorsPanel.tsx:43-53` does, but with the sRGB transfer function (see [074](074-reduce-colors-dither-srgb-assumption.md)). Add an `instanceof Uint8Array` guard in the WASM wrappers that throws on the wrong type. For Content-Aware Fill on f32, convert the result back with `convertRgba8ToF32` (or add a float inpaint path).

## Done when
- Content-Aware Fill and Generate Palette give correct results on rgba32f documents.
- Wrappers throw a clear error if handed a `Float32Array`.


## Resolution
Content-Aware Fill and Generate Palette (extract) now convert a Float32 composite with `clampF32ToUint8` before WASM; the fill result is still decoded back with `convertRgba8ToF32`. `quantize`, `inpaintRegion` and `matchPaletteIndices` now throw a clear `TypeError` via a new `assertBytes()` guard in `src/wasm/index.ts` when given a non-byte array.
