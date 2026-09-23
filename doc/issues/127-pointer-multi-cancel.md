# 127 · No pointerId tracking or pointercancel handling

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Input pipeline |
| Verified | Yes |

## Problem
A second pointer (palm, second finger) restarts/merges into the stroke; `pointercancel` / lost capture don't end it.

## Where
- `src/core/services/useCanvas.ts:130-237`

## Suggested fix
Track the stroke's pointerId; end the stroke on cancel / lost capture.

## Done when
- A palm touch doesn't disturb a pen stroke; cancelled pointers end the stroke.

## Resolution
useCanvas records the stroke's pointerId: other pointers are ignored while a stroke is in progress (no restart/merge from a palm or second finger), only the stroke's pointer ends it, and the new handlePointerCancel (wired to onPointerCancel and onLostPointerCapture on both canvases) ends the stroke when its pointer is cancelled or loses capture.
