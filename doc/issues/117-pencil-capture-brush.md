# 117 · Pencil capture-selection-as-brush is wrong for rgba32f/indexed8 and reads stale state

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Pencil |
| Verified | Yes |

## Problem
Always reads 4 bytes per pixel as sRGB bytes (float and indexed layers produce garbage) and uses module-level `_renderer`/`_layer` from the last pointer event (possibly another tab).

## Where
- `src/core/tools/Pencil/Pencil.tsx:1227-1296`

## Suggested fix
Read the active layer through the canvas handle at click time and convert per format.

## Done when
- Captured brushes match the selection on every format and tab.

## Resolution
captureSelectionAsBrush takes the active layer id and swatches at click time. It uses the remembered renderer/layer only if that layer is still live and is the active layer (otherwise it drops the references), and checks that the selection matches the canvas. Pixels are converted per format: rgba32f through linearToSrgbChannel, indexed8 through the palette (255 = transparent).
