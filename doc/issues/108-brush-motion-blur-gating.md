# 108 · Brush motion blur disables the WASM batch and flips render paths

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance / Correctness |
| Area | Tools / Brush |
| Verified | Yes |

## Problem
The default brush has motion blur 5%. Any dynamic brush with motion blur takes the per-pixel JS path; elongation switches on at velocity 0.01 as a step, so a stroke alternates between elongated JS stamps and round WASM stamps. The bitmap path drops motion blur entirely.

## Where
- `src/core/tools/Brush/stampEngine.ts:583-587, 783-791, 1267-1269`

## Suggested fix
Scale elongation smoothly with velocity and treat negligible elongation as none so the fast path stays in use; keep the JS path only for significant elongation.

## Done when
- Default brush strokes use the WASM path and render consistently.

## Resolution
Motion blur below 7% (≤1.2× elongation) is treated as off everywhere (effectiveMotionBlur); above it elongation ramps smoothly with velocity (full at 25% of tracking speed). Both WASM batches require motion blur to be effectively off, so a stroke never mixes elongated JS stamps and round WASM stamps; the default brush (5%) keeps the batch path.
