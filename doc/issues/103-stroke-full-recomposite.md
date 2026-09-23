# 103 · Incremental composite is disabled during every stroke

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | High |
| Category | Performance |
| Area | Rendering |
| Verified | Yes |

## Problem
`renderPlan` excludes the incremental path while `strokeActive`, so every stroke frame re-composites every layer over the whole canvas and copies the full canvas to `stableTex`. The workaround was added for an 'unknown' dirty-rect leak; 100/101/102 are concrete causes.

## Where
- `src/graphics/webgpu/frame/RenderPlanExecutor.ts:1091-1111`

## Suggested fix
After fixing the dirty-rect leaks, allow the incremental path during strokes.

## Done when
- Stroke frames composite only the dirty rect.

## Resolution
The incremental composite is allowed during strokes again (the !strokeActive gate is removed). The dirty-rect leaks it hid are fixed at the source: stamp bboxes (107, 119), tiled-mode marking (100) and the masking full-layer pen flush (101). strokeEnd now calls invalidateRenderCache, so the stroke's final frame is a full composite that rebuilds stableTex and re-applies bypassed effects. Please verify visually with fast strokes (brush, pencil, eraser, tiled mode).
