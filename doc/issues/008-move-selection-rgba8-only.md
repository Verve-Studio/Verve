# 008 · Moving a selection only works on rgba8 and is O(canvas) per move

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Correctness / Performance |
| Area | Tools / Move |
| Verified | No — reported by reviewer |

## Problem
`applySelectionMove` hard-codes 4 bytes/pixel, `/255` alpha, `Math.round` and `Math.min(255, …)`.
- **rgba32f:** rounds every channel to 0 or 1 and mixes 0–1 with 0–255 alpha, destroying the moved pixels.
- **indexed8:** indexes a 1-byte buffer with ×4 stride and multiplies palette indices by alpha, scrambling the layer.
- **Perf:** every move runs `dst.set(src)` plus two full-canvas loops, then `flushLayer` with no dirty rect (full upload).

## Where
- `src/core/tools/Move/Move.tsx:343-406`

## Suggested fix
Branch on `layer.format`: float math without rounding for rgba32f; index copy without blending (threshold on mask) for indexed8. Restrict loops to `selectionBBox ∪ translatedBBox` and `markDirtyRect` that union.

## Done when
- Moving a selection on rgba8, rgba32f and indexed8 layers preserves pixels exactly.
- Move cost scales with selection size, not canvas size.


## Resolution
Rewrote `applySelectionMove` in `Move.tsx`. It works per format: rgba8 bytes, rgba32f floats with no rounding, indexed8 index copy with the mask thresholded at 128. The mask bbox is computed once per drag, and only (origin ∪ previous position ∪ new position) ∩ layer is restored and rewritten. That rect is marked with `markDirtyRect`, and indexed8 flushes with the palette. Erasing now lowers only alpha (straight-alpha correct); before, partially selected edges were darkened.
