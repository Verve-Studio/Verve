# Unified Rasterization Pipeline

## Overview
Verve currently has multiple compositing paths for different outcomes (screen preview, flattening operations, and export), which creates a risk that saved or flattened output does not exactly match what the user sees on screen. This feature defines one unified rasterization pipeline contract so flatten and export are always derived from the same composited result shown in the canvas. The primary goal for V1 is correctness and full parity with visible compositing behavior, including adjustment layers, layer masks, adjustment masks, blend modes, opacity, and visibility semantics.

### Problem Statement
- Users must be able to trust that Flatten Image and exported files represent the same pixels they see in the canvas composited preview.
- Divergent rasterization/compositing paths create correctness regressions, especially as new adjustment types and blending features are added.

### Goals
- Establish one central compositing contract used by screen preview, flatten, and export.
- Guarantee pixel-identical output between Flatten Image and Export for the same document state.
- Guarantee parity with visible composited result (ignoring non-image UI overlays such as checkerboard, guides, or panel chrome).
- Prioritize correctness first while keeping the architecture extensible for color management, higher bit depth/HDR, and future performance optimization.

### Non-goals
- V1 does not introduce new adjustment algorithms or new blend modes.
- V1 does not require changing the user-facing Export dialog UX.
- V1 does not require shipping color-management or HDR output yet; it must only preserve extension points for those additions.

## User Interaction
1. The user edits a document with any mix of visible layers, masks, and adjustment layers.
2. The canvas preview continues to render through GPU compositing as it does today.
3. The user chooses Flatten Image.
4. Verve replaces the layer stack with a single flattened layer whose pixels match the current composited canvas result.
5. The user chooses Export and selects PNG, JPEG, or WebP.
6. Verve exports bytes derived from the same unified composited result used by flattening.
7. If the user flattens and then exports immediately (without additional edits), the exported output matches the pre-flatten exported output exactly, except for format-specific encoding constraints (for example JPEG alpha handling).

## Functional Requirements
- The system must define a single central rasterization/compositing pipeline contract that is the source of truth for:
- Screen compositing result used for the image content.
- Flatten Image output pixels.
- Export source pixels before format encoding.
- V1 must include full parity with currently visible compositing semantics, including:
- Layer visibility and opacity.
- Layer blend modes.
- Layer masks.
- Adjustment layer evaluation order.
- Adjustment masks (selection-derived adjustment masks).
- Parent-child adjustment scoping semantics currently used by the layer stack.
- Flatten Image must consume the unified composited output and must not use a separate legacy merge implementation for final flattened pixels.
- Export must consume the same unified composited output used by flatten and must not use an independent compositing implementation.
- Flatten and export source pixels must be pixel-identical for a given document state and canvas bounds.
- Screen rendering must remain GPU-only.
- The unified pipeline must be GPU-first for flatten/export as well (reuse render/composite path that drives screen output wherever possible).
- If a direct GPU reuse path is unavailable for a given operation/context, the system must provide a CPU fallback path for flatten/export with these constraints:
- Fallback behavior must match unified compositing semantics exactly.
- Fallback must be modular and reusable, not a one-off export-only branch.
- Fallback must be extensible so newly added blend/adjustment operations can implement both GPU and fallback evaluators behind the same compositing contract.
- Existing flatten/export logic must be replaced immediately by this pipeline (no feature flag, no dual runtime mode).
- The architecture should preserve extension seams for:
- Future color-space aware compositing and conversion.
- Higher precision pipelines (high bit depth/HDR).
- Future performance paths (tiling, caching, incremental recomposition) without changing user-visible output semantics.

## Acceptance Criteria
- For any supported document state in V1 scope, Flatten Image output pixels are identical to Export source pixels for the same state.
- For any supported document state in V1 scope, Flatten Image and Export source pixels match the visible composited canvas image content.
- Toggling visibility, changing opacity, or changing blend mode on any relevant layer is reflected identically in screen, flatten, and export outcomes.
- Adjustment layers and adjustment masks produce identical visual influence across screen, flatten, and export.
- Layer masks produce identical clipping behavior across screen, flatten, and export.
- Replacing legacy flatten/export compositing paths with the unified path does not require enabling any runtime flag.
- JPEG export remains format-correct (alpha composited over selected background color), while PNG/WebP preserve alpha as expected.

### Definition of Done
- Unified rasterization pipeline contract is documented and used by all flatten/export call sites.
- Legacy divergent flatten/export compositing logic is removed from active code paths.
- Automated parity tests exist for flatten vs export and screen-reference equivalence scenarios.
- Manual QA matrix covering masks, adjustments, blend modes, and visibility passes.
- No known parity bugs remain open for in-scope V1 semantics at release sign-off.

### Test Scenarios
- Single opaque layer, no masks, no adjustments.
- Multiple layers with mixed blend modes and opacities.
- Hidden layers interleaved with visible layers.
- Layer mask applied to a parent layer with partial transparency.
- Parent pixel layer plus multiple child adjustment layers.
- Adjustment layer with baked selection mask enabled/disabled.
- Combination of layer mask and adjustment mask on the same parent context.
- Out-of-canvas layer offsets (negative and positive), including partially visible layer bounds.
- Transparent canvas export to PNG/WebP and JPEG with explicit background fill.
- Flatten followed by export, and export before flatten, producing matching image content.

## Edge Cases & Constraints
- Hidden layers and hidden adjustment layers must have zero influence on flatten/export output.
- Mask and adjustment child relationships must follow existing parent scoping behavior; no re-parenting side effects may occur during flatten/export evaluation.
- Nested adjustments are constrained by current layer model semantics. If deeper nesting is unsupported by the layer model, pipeline behavior must remain deterministic and match current on-screen results.
- Layers with bounds offset beyond canvas edges must be clipped to canvas extents consistently across screen, flatten, and export.
- Flatten/export must operate on document pixel bounds, not viewport zoom/pan.
- Transparency handling must be consistent:
- Flattened internal pixel buffer preserves alpha.
- Format encoders apply format-specific alpha behavior after compositing parity is satisfied.
- Canvas UI-only visuals (checkerboard transparency preview, guides, selection overlays, handles) must never be baked into flatten/export output.

## Related Features
- [adjustment-menu.md](adjustment-menu.md)
- [brightness-contrast.md](brightness-contrast.md)
- [hue-saturation.md](hue-saturation.md)
- [color-vibrance.md](color-vibrance.md)
- [color-balance.md](color-balance.md)
- [black-and-white.md](black-and-white.md)
- [color-temperature.md](color-temperature.md)
- [color-invert.md](color-invert.md)
- [selective-color.md](selective-color.md)
- [curves.md](curves.md)
