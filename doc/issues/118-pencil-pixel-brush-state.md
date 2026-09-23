# 118 · Pencil pixel-brush selection desyncs from the UI

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Pencil |
| Verified | Yes |

## Problem
`pencilOptions.pixelBrush` is module state but the options UI starts at null; switching tools shows 'none' while painting with the brush; removed brushes / document switches never clear it.

## Where
- `src/core/tools/Pencil/Pencil.tsx:47, 1461, 1514-1523`

## Suggested fix
Initialise UI state from `pencilOptions.pixelBrush`; clear it when the brush no longer exists.

## Done when
- The options bar always reflects the brush that paints.

## Resolution
PencilOptions initialises its brush state from pencilOptions.pixelBrush, and an effect clears the painting brush when it no longer exists in the document or user brush lists.
