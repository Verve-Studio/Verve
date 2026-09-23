# 014 · Preview-bypass state leaks into flatten / export / merge

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Correctness |
| Area | Rasterization pipeline |
| Verified | No — reported by reviewer |

## Problem
CLAUDE.md: "Temporary preview-bypass state must never leak into final flatten/export/merge outputs." There are two leaks:
1. `rasterizeComposite` uses `buildRenderPlan()`, which passes `activeScope().adjustmentPreview.snapshot()` as bypassed ids (`Canvas.tsx:260`). `rebuildPlanForLayers` does the same. An adjustment toggled off for preview (e.g. `CurvesPanel.tsx:387`) is missing from the saved/exported output.
2. `readFlattenedPlan` → `encodePlanToComposite` honours `executor.previewMode`, which skips standalone effects. The text-edit effect holds preview mode on for the whole edit session (`Canvas.tsx:436`) and sets `gl.visible = false` (`Canvas.tsx:435`). Saving or exporting while editing text drops every standalone effect **and** the text layer.

## Where
- `src/ux/main/Canvas/canvasHandle.ts:314, 379`
- `src/ux/main/Canvas/Canvas.tsx:260, 435-436`
- `src/graphics/webgpu/frame/RenderPlanExecutor.ts:486, 517-520`

## Suggested fix
Rasterization plans always use an empty bypass set. `readFlattenedPlan` / `readAdjustmentInputPlan` save and force `previewMode = false` and `strokeActive = false` around the encode, restoring in `finally`. The hidden-text-layer case needs a visibility override in the export plan (or commit the text edit before export).

## Done when
- Export with an adjustment in preview-bypass includes the adjustment.
- Export while editing text includes the text layer and all effects.


## Resolution
Three changes:
- `RenderPlanExecutor.withOutputEncode()` forces `previewMode=false`, `strokeActive=false` and ignores a new screen-only hidden-layer set. `readFlattenedPlan` (the single flatten/export/merge encode) runs inside it.
- The text-edit effect in `Canvas.tsx` now hides the layer with `renderer.setScreenHidden()` instead of `gl.visible = false`.
- `rasterizeComposite` uses a new `buildOutputPlan()` (empty bypass set, and re-rasterizes a text layer that is mid-edit first). `rebuildPlanForLayers` (merge/rasterize) also passes an empty bypass set.

`readAdjustmentInputPixels` (panel histograms) intentionally still uses the screen plan.
