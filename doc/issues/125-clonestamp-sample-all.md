# 125 · Clone Stamp Sample All Layers: taps paint nothing; masks/adjustments ignored

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Clone Stamp |
| Verified | Yes |

## Problem
A dab that ends before the async flatten resolves is discarded (and still records history); the flatten ignores layer masks and adjustments.

## Where
- `src/core/tools/CloneStamp/CloneStamp.tsx:166-216`

## Suggested fix
Queue segments until the readback resolves and paint them; flatten the visible render plan.

## Done when
- Quick taps clone; the source matches the screen.

## Resolution
Sample All Layers reads the document through the new ToolContext.readCompositePixels (renderer.readFlattenedPlan of the output plan: masks, adjustments and effects included). Segments drawn before the readback resolves are queued and painted when it lands; a pointer-up that comes first defers the stroke end, which then ends the stroke and commits history itself (skipHistory on the up), so quick taps clone and are undoable. Readback errors are shown.
