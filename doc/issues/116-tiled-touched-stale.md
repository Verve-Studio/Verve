# 116 · Tiled mode leaves stale coverage in `touched`

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Brush, renderer |
| Verified | Yes |

## Problem
In tiled mode `touched` is written at wrapped coordinates but the stroke bbox that is cleared later is unwrapped and clamped, so wrapped coverage survives and throttles the next stroke there.

## Where
- `src/core/tools/Brush/Brush.tsx:617-623`
- `src/graphics/webgpu/rendering/WebGPURenderer.ts:209-231`

## Suggested fix
Don't record `lastDirtyRect` for tiled strokes (forces a full clear).

## Done when
- Painting across a tile edge twice deposits normally.

## Resolution
Tiled strokes no longer record touched.lastDirtyRect (the next acquire fully clears), the build-up tick fully clears touched in tiled mode, and wet edges scan the whole canvas for tiled strokes instead of the unwrapped bbox.
