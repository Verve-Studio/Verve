# 100 · Tiled mode: Brush strokes with a mouse are never uploaded

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Correctness (regression from 047) |
| Area | Tools / Brush |
| Verified | Yes |

## Problem
In tiled mode Brush skips `markDirtyRect`, and since 047 `commitPendingFlush` only flushes when `hasPendingUpload()` — so mouse strokes in tiled mode write `layer.data` but never reach the GPU until something unrelated flushes.

## Where
- `src/core/tools/Brush/Brush.tsx:121-123, 312-324`

## Suggested fix
Mark the stamp bounding box wrapped into up to four layer-local rects in tiled mode (or mark the full layer dirty).

## Done when
- Brush strokes show live in tiled mode with mouse and pen.

## Resolution
Brush marks the segment bbox in tiled mode too, split into its (up to 4) wrapped pieces (markWrappedDirty), so commitPendingFlush's hasPendingUpload check sees pending work and mouse strokes upload live.
