# 079 · Merge / rasterize plans don't pass `pixelFormat` (defaults to rgba8)

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Low |
| Category | Correctness |
| Area | Canvas / Rasterization |
| Verified | No — reported by reviewer |

## Problem
`rebuildPlanForLayers` and `rasterizeGroupChildren` don't pass `pixelFormat`, so it defaults to `'rgba8'`. For indexed8 documents, merge and rasterize-layer output includes adjustments that the screen plan excludes (WYSIWYG mismatch).

## Where
- `src/ux/main/Canvas/canvasHandle.ts:309-316, 431-439`

## Suggested fix
Pass the document's `pixelFormat` through to plan building in both functions.

## Done when
- Merging layers in an indexed8 document produces what's shown on screen.


## Resolution
useCanvasHandle takes a pixelFormatRef (fed from Canvas state) and passes it to the merge/rasterize buildCanvasRenderPlan and to rasterizeGroupChildren's buildSubPlan, so indexed8 output matches the screen plan.
