# 065 · Pencil does full-layer uploads on several paths

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | Tools / Pencil |
| Verified | No — reported by reviewer |

## Problem
- Pixel-brush path (`:1060-1085`, `paintBrushStamp` at `:426`) never calls `markDirtyRect`, so every move uploads the whole layer.
- Size > 1 pointer-down (`:945-969`) flushes without a dirty rect.
- Pointer-up (`:1130-1132`) paints the pending pixel-perfect pixel without marking it dirty, so every stroke end is a full upload.
- `paintOnePixel` allocates `srgbColorToLinearF32(...)` per pixel (`:537`).

## Where
- `src/core/tools/Pencil/Pencil.tsx:426, 537, 945-969, 1060-1085, 1130-1132`

## Suggested fix
Mark the bresenham bbox plus pad as dirty on each path; hoist the colour conversion to once per segment (or per stroke).

## Done when
- Pencil strokes upload only dirty patches.


## Resolution
Added `markCanvasBoxDirty()` to Pencil (it marks the whole layer in tiled mode, where stamps wrap) and used it for:
- the pixel-brush path (segment bbox ± pad, marked after the loop because growing can move the layer)
- the size>1 pointer-down stamp
- every `paintOnePixel`, which covers the pending pixel-perfect pixel at stroke end

So those flushes upload only the painted patch. `srgbColorToLinearF32(primaryColor)` is memoised on the colour object instead of running for every pixel.
