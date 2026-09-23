# 107 · Brush stamp bounding box ignores angle, square tips and shear

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Brush |
| Verified | Yes |

## Problem
The stamp bbox is sized from radius and motion only. A 45° square tip, a rotated bitmap tip or a tilt-shear brush reaches beyond it, and all three render paths clip to it, cutting stamp corners.

## Where
- `src/core/tools/Brush/stampEngine.ts:700-711`
- `src/wasm/brushStamp.ts:696-699`

## Suggested fix
Use a shape/angle/shear-aware extent (√2·r for square tips, + |shear|·r).

## Done when
- Rotated square tips and sheared stamps are not clipped.

## Resolution
applyStamp's bbox is the rotated tip-local box (x: radius + |shear|·radius·roundness, y: radius·roundness) plus the motion stretch along the stroke direction — contains round/square/diamond/bitmap tips at any angle and sheared stamps. The WASM append clip derives from it.
