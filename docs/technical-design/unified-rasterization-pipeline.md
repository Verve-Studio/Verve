# Technical Design: Unified Rasterization Pipeline

## Overview

Verve currently has two different rasterization behaviors for final image output:

- Export uses the WebGL render plan path via Canvas handle exportFlatPixels and WebGLRenderer readFlattenedPlan.
- Flatten Image uses a separate CPU-side compositeLayers implementation in useLayers.

This split causes correctness drift. The new design introduces one centralized rasterization pipeline abstraction that both flatten and export must call. The pipeline is GPU-first and reuses the same render/composite plan model already used by visible canvas compositing. CPU fallback exists only as a controlled backup for rasterization requests that cannot complete on GPU, and it is built behind the same contract so parity can be tested.

Primary invariant for V1:

- flatten output == export source output == visible composited image content

Visible composited image content means the document composite only, excluding UI overlays such as checkerboard, guides, selection outlines, and handles.

## Current-State Diagnosis

## What is unified today

- Canvas preview and export share plan semantics from Canvas buildRenderPlan and canvasPlan buildRenderPlan.
- Export path already calls Canvas handle exportFlatPixels, which reads pixels from WebGLRenderer readFlattenedPlan using the plan (includes masks and adjustments).

## Where divergence exists now

1. Flatten uses separate CPU compositing logic:
   - useLayers has local compositeLayers that manually blends layers.
   - It skips adjustment layers entirely.
   - It does not check layer.visible during flatten; hidden non-mask layers can be merged.
   - It re-implements blend math independently from shader logic.

2. Flatten and export therefore are not guaranteed parity:
   - Export uses plan entries including adjustment-group and adjustment ops.
   - Flatten currently does not use those plan entries.

3. Duplicate raster paths increase maintenance risk:
   - Blend mode and mask semantics are implemented in both shader path and CPU helper path.
   - Any new adjustment or blending feature can drift unless manually duplicated.

## Root Cause

There is no single document-level rasterization service with a required contract for all final-output operations.

## Proposed Architecture

## Central Abstraction

Add a new renderer-facing service in a new rasterization module:

- src/rasterization/UnifiedRasterPipeline.ts

This module owns one public entrypoint used by both flatten and export.

Proposed API shape:

- rasterizeDocument(request): RasterizeResult

Request includes:

- plan (RenderPlanEntry[]), always generated from the same source as visible canvas compositing
- width and height
- reason: flatten | export | sample
- preferGpu: boolean (default true)
- fallbackPolicy: never | if-unavailable | always (default if-unavailable)

Result includes:

- data: Uint8Array RGBA top-row-first
- width and height
- backendUsed: gpu | cpu
- warning optional string

## Source of Truth

The compositing plan remains the single source of truth:

- src/components/window/Canvas/canvasPlan.ts

No flatten/export-specific plan builder is allowed.

Canvas visible rendering, flatten, and export all consume plan entries built from the same state and layer/mask maps.

## GPU-First Strategy

GPU path is primary and uses existing WebGLRenderer compositing machinery. The implementation refactors WebGLRenderer internals to avoid duplicated pass execution between renderPlan and readFlattenedPlan.

Add a shared internal helper in WebGLRenderer:

- executePlanToCompositeTexture(plan): final texture plus framebuffer selector

Then:

- renderPlan uses executePlanToCompositeTexture then blits to screen with checkerboard behind it.
- readFlattenedPlan uses executePlanToCompositeTexture then readPixels.

This guarantees screen and readback traverse exactly the same GPU pass sequence.

## CPU Fallback Strategy

CPU fallback is only used when unavoidable:

- WebGL renderer unavailable
- context lost
- readback failure

CPU fallback lives behind the same pipeline contract:

- src/rasterization/CpuRasterPipeline.ts

It evaluates the same RenderPlanEntry model in software. It is not flatten-specific or export-specific.

CPU evaluator design:

- Layer blend pass evaluator
- Mask application evaluator
- Adjustment op evaluator registry keyed by adjustment kind
- Shared blend mode operator table

This allows parity tests to compare GPU vs CPU on identical plan fixtures.

## Module Boundaries and Responsibilities

## New modules

1. src/rasterization/types.ts
   - Request and result types for unified rasterization.
   - Fallback policy and backend enum.

2. src/rasterization/UnifiedRasterPipeline.ts
   - Orchestration entrypoint.
   - Chooses GPU first, falls back to CPU per policy.
   - Normalizes errors and warnings.

3. src/rasterization/GpuRasterPipeline.ts
   - Thin adapter over WebGLRenderer readback API.
   - No compositing semantics here; only execution and readback.

4. src/rasterization/CpuRasterPipeline.ts
   - Software plan evaluator for fallback.
   - Adjustment evaluator registry for extensibility.

5. src/rasterization/index.ts
   - Public exports.

## Existing modules changed

1. Canvas plan builder:
   - Keeps ownership of plan construction from app layer state.
   - No flatten/export special logic.

2. WebGLRenderer:
   - Introduce single internal plan executor shared by screen and readback.
   - Expose stable readback method used by unified pipeline.

3. Canvas handle:
   - Replace exportFlatPixels with generic rasterizeComposite call that delegates to unified pipeline.
   - Keep one handle for consumers.

4. Hooks and app call sites:
   - Flatten and export must both call same handle method and pipeline.

## New and Changed Types and Interfaces

## src/rasterization/types.ts

- RasterBackend = gpu | cpu
- RasterReason = flatten | export | sample
- RasterFallbackPolicy = never | if-unavailable | always

- RasterizeDocumentRequest
  - plan: RenderPlanEntry[]
  - width: number
  - height: number
  - reason: RasterReason
  - preferGpu optional boolean
  - fallbackPolicy optional RasterFallbackPolicy

- RasterizeDocumentResult
  - data: Uint8Array
  - width: number
  - height: number
  - backendUsed: RasterBackend
  - warning optional string

## src/components/window/Canvas/canvasHandle.ts

Replace specific method name:

- exportFlatPixels becomes rasterizeComposite

Proposed signature:

- rasterizeComposite(reason: flatten | export | sample): { data, width, height, backendUsed } | null

Backward compatibility approach for short migration window:

- Keep exportFlatPixels as a deprecated alias that internally forwards to rasterizeComposite with reason export.
- Remove alias in cleanup step once all call sites are migrated.

## src/webgl/WebGLRenderer.ts

Introduce internal execution contract:

- private executePlanToComposite(plan): { finalTexture, finalFramebuffer }

Keep public readback:

- readFlattenedPlan(plan): Uint8Array

but implement through executePlanToComposite.

## File-by-File Change Plan

The following list is implementation-targeted and scoped to required areas.

## Canvas area

1. src/components/window/Canvas/canvasPlan.ts
   - Keep plan semantics as source of truth.
   - Export a stable plan builder function name for shared use by canvas and pipeline caller code.
   - Add explicit comments documenting parity-critical ordering and visibility rules.

2. src/components/window/Canvas/Canvas.tsx
   - No behavior rewrite in UI flow.
   - Ensure buildRenderPlan remains the only plan producer for on-screen and handle readback.
   - Optionally memoize plan build for one render tick to avoid duplicate plan generation when render and export happen back-to-back.

3. src/components/window/Canvas/canvasHandle.ts
   - Add rasterizeComposite method delegating to UnifiedRasterPipeline.
   - Keep buildRenderArgs as single point for layer map, mask map, and plan generation.
   - Route old exportFlatPixels to rasterizeComposite alias during migration.

## Export area

1. src/export/exportPng.ts
   - Keep encoder-only responsibility.
   - No compositing logic added.

2. src/export/exportWebp.ts
   - Keep encoder-only responsibility.
   - No compositing logic added.

3. src/export/exportJpeg.ts
   - Keep background fill behavior at encoding stage only.
   - Input pixels remain unified RGBA output from pipeline.

4. src/App.tsx
   - Export handler switches from exportFlatPixels call to rasterizeComposite call.
   - No branch to alternate raster code path.

Optional architecture cleanup aligned with AGENTS:

- Move export handler from App.tsx into a dedicated hook, for example useExportOps, to keep App as orchestrator-only.

## WebGL area

1. src/webgl/WebGLRenderer.ts
   - Refactor renderPlan and readFlattenedPlan to share executePlanToComposite helper.
   - Ensure adjustment-group and standalone adjustment ops execute through identical pass sequence for screen and readback.
   - Ensure readback excludes checkerboard and overlays.
   - Add explicit WebGL state reset discipline around framebuffer and viewport after readback.

2. src/webgl/shaders.ts
   - No new shader required for this feature unless parity bug fixes are found.
   - If any blend behavior correction is needed, update once and rely on unified GPU path everywhere.

## Hooks area

1. src/hooks/useLayers.ts
   - Remove CPU compositeLayers usage from handleFlattenImage.
   - Flatten obtains unified pixels via canvas handle rasterizeComposite with reason flatten.
   - Keep merge selected/down/visible behavior as-is for now unless separately scoped; this feature targets flatten and export parity.

2. src/hooks/useFileOps.ts
   - No required change for export pipeline directly.
   - Optional if export behavior is moved from App into this hook or a new hook.

3. src/hooks/useCanvas.ts and src/hooks/useWebGL.ts
   - No required semantic changes.
   - Optional: expose context-loss status if needed for fallback policy triggers.

## New rasterization module area

1. src/rasterization/types.ts
2. src/rasterization/UnifiedRasterPipeline.ts
3. src/rasterization/GpuRasterPipeline.ts
4. src/rasterization/CpuRasterPipeline.ts
5. src/rasterization/index.ts

## GPU Readback Strategy and Synchronization

## Readback flow

1. Build compositing plan from current layer state using existing plan builder.
2. Execute compositing passes into offscreen ping-pong framebuffers.
3. Read final framebuffer via readPixels into Uint8Array.
4. Return top-row-first RGBA bytes.

## Synchronization concerns

- readPixels is an implicit synchronization point and can stall the main thread.
- To minimize stalls:
  - Reuse framebuffer allocations and avoid per-request allocation churn.
  - Reuse output buffers where safe.
  - Avoid redundant plan rebuilds in one action flow.
- Do not call gl.finish; rely on readPixels barrier.

## State safety concerns

- readback must not leave modified GL state that affects subsequent screen render.
- Helper must restore framebuffer binding and viewport consistently.
- On readback failure, surface error to unified pipeline and trigger fallback policy.

## Avoiding Duplicate Raster Code Paths

Hard rule for implementation:

- No operation may directly composite layers outside UnifiedRasterPipeline for flatten/export.

Actions:

1. Remove flatten CPU helper path in useLayers.
2. Keep WebGLRenderer pass execution in one shared helper used by both renderPlan and readFlattenedPlan.
3. Keep export encoders strictly encoding-only.
4. Keep any legacy API names as temporary aliases only, forwarding to unified entrypoint.

## CPU Fallback Contract and Plug-in Location

## Contract

CpuRasterPipeline implements the same input and output contract as GpuRasterPipeline:

- input: RenderPlanEntry plus dimensions
- output: Uint8Array RGBA in same orientation and alpha convention

## Plug-in point

UnifiedRasterPipeline flow:

1. Try GPU backend if preferGpu true.
2. If GPU unavailable or failed:
   - If fallbackPolicy is if-unavailable or always, run CPU backend.
   - If fallbackPolicy is never, return error.

## Parity design

- CPU evaluators are keyed by the same adjustment operation kinds used by RenderPlanEntry.
- Adding a new adjustment requires:
  - GPU evaluator already in WebGLRenderer
  - CPU evaluator registration in CpuRasterPipeline
  - parity fixture test update

This enforces extensibility and testability.

## Error Handling and Resilience

## Error classes

- RasterizationUnavailableError: no renderer/context and fallback disabled.
- RasterizationExecutionError: GPU pass or readback failure.
- RasterizationFallbackError: both GPU and CPU failed.

## Behavior

- Flatten action:
  - On success, commit flattened layer.
  - On failure, keep document unchanged and show non-destructive error notification.

- Export action:
  - On success, continue format encode and save.
  - On failure, abort write and show actionable error.

- Telemetry/logging:
  - Log backendUsed and fallback events for diagnosis.

## Migration Strategy (No Feature Flag)

Migration is immediate and single-path, but performed in safe sequence:

1. Introduce rasterization module and wire through canvas handle without changing callers.
2. Update export call path to use new handle method.
3. Update flatten call path in useLayers to use same handle method.
4. Keep temporary alias exportFlatPixels forwarding to new method.
5. Remove obsolete flatten CPU composite helper after callers are switched.
6. Run parity test suite and manual matrix before merge.
7. Remove deprecated alias in follow-up cleanup once no references remain.

No runtime flag is introduced. Old flatten path is deleted from active flow in same rollout.

## Validation Strategy

## Unit tests

1. Plan invariants:
   - Adjustment-group ordering and visibility semantics.
   - Mask mapping and parent scoping.

2. CPU evaluator tests:
   - Blend modes, opacity, mask application, bounds clipping.
   - Adjustment op math against known fixtures.

3. Pipeline selector tests:
   - GPU success path.
   - GPU failure then CPU fallback.
   - fallbackPolicy never behavior.

## Integration tests

1. Flatten vs export parity:
   - Given document fixture, flatten pixel buffer equals export source buffer.

2. Visible parity:
   - readback from unified path equals renderPlan composite texture readback for same plan.

3. Adjustment and mask matrix:
   - parent layer plus child adjustments and masks
   - hidden layers and hidden adjustments
   - offsets and out-of-bounds clipping

4. Format-specific handling:
   - PNG and WebP preserve alpha
   - JPEG background fill applied only in encoder stage

## Manual QA matrix

- Multi-layer blend stack with mixed opacities
- Layer masks and adjustment masks combinations
- Visibility toggles at each stack position
- Negative and positive offsets, partially outside canvas
- Transparent background scenarios for PNG/WebP/JPEG
- Export before flatten and flatten then export comparison

## Performance Considerations

1. readPixels stalls are expected for synchronous export/flatten.
2. Reuse existing ping-pong FBOs and avoid new allocations in hot path.
3. Optional buffer pooling for output Uint8Array to reduce GC.
4. Keep CPU fallback out of normal path to avoid duplicate compute cost.
5. Avoid any extra compositing pass solely for export/flatten beyond required readback pass.

## Future Extensibility Hooks

The unified request/result contract should include metadata slots to support future upgrades without API break:

- colorSpaceIntent field placeholder for display-p3 or linear-srgb pipeline work
- bitDepth field placeholder for 8-bit now, 16-bit/HDR later
- toneMapPolicy placeholder for HDR export behavior

Design principle:

- Future color management or HDR changes should modify one pipeline and one plan semantics path, not separate flatten/export implementations.

## Architectural Constraints and Compliance

This design follows AGENTS requirements:

- GPU render path remains canonical source for compositing semantics.
- Flatten and export use one central abstraction.
- No renderer-to-main direct imports are introduced.
- Hook boundaries remain cohesive: useLayers handles flatten action orchestration but not compositing implementation.
- Export encoders remain focused and format-specific.

## Open Questions

1. Scope of merge operations:
   - Merge Selected, Merge Down, and Merge Visible currently use CPU helper semantics.
   - Not required by this feature, but they remain potential parity drift vectors.

2. CPU fallback depth for adjustments:
   - Should all current adjustments be implemented in CPU fallback in V1, or should unsupported op kinds fail fast with user message until implemented?

3. Sampling tools alignment:
   - Eyedropper and magic wand currently perform independent compositing reads in tool code.
   - Should they adopt unified sample reason path in this rollout or a follow-up to keep scope focused?

## Implementation Steps

1. Add rasterization module files under src/rasterization with shared request/result contracts and GPU plus CPU adapters.
2. Refactor WebGLRenderer internal plan execution into one helper consumed by renderPlan and readFlattenedPlan.
3. Add canvas handle rasterizeComposite method and temporary exportFlatPixels forwarding alias.
4. Switch App export flow to rasterizeComposite result, then pass data to format encoders.
5. Switch useLayers flatten flow to rasterizeComposite and remove direct compositeLayers use for flatten.
6. Delete obsolete flatten-only CPU compositing helper once compilation references are clean.
7. Add unit and integration parity tests for flatten/export/visible equality and fallback behavior.
8. Run manual parity matrix and resolve mismatches before release.
