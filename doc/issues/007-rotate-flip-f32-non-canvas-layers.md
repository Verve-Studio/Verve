# 007 · Rotate/Flip corrupt rgba32f layers that aren't canvas-sized

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Correctness |
| Area | Services / Canvas transforms |
| Verified | No — reported by reviewer |

## Problem
`getLayerRawData` returns the **layer-local** buffer (`canvasHandle.ts:900-904`), but `rotateF32` / `flipF32` treat it as a canvas-sized W×H buffer. Out-of-range reads return `undefined` → NaN. No `${id}:geo` entry is written, so init treats the result as a full-canvas layer at 0,0. New layers start at 128×128, so this hits most multi-layer rgba32f documents.

## Where
- `src/core/services/useCanvasTransforms.ts:676-685, 768-772`

## Suggested fix
Either rotate/flip the layer-local buffer with its own width/height, remap the offset and emit `${id}:geo`, or scatter into a canvas-sized buffer first like the rgba8 and indexed paths do.

## Done when
- Rotating/flipping an rgba32f document with a small offset layer keeps content, size and position correct; no NaN pixels.


## Resolution
Rotate/Flip now transform rgba32f layers in layer-local space (`layerWidth×layerHeight` from `captureAllLayerGeometry`) and emit a remapped `${id}:geo` entry (`rotatedGeo` / `flippedGeo` helpers in `useCanvasTransforms.ts`). The offset math was hand-verified for 90° CW, 180° and 270° CW.
