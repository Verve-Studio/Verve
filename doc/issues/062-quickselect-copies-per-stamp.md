# 062 · Quick Select copies canvas-sized buffers per stamp

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | Tools / QuickSelect |
| Verified | No — reported by reviewer |

## Problem
Every stamp (several per move) does `new Uint8Array(strokeMask)` plus an O(canvas) `mergeMask` and a notify. On large documents dragging is O(canvas × stamps).

## Where
- `src/core/tools/QuickSelect/QuickSelect.tsx:246`

## Suggested fix
Merge once per pointer move, or pass the dirty bbox to a region-limited merge. Keep the pre-stroke mask and recombine only changed rows.

## Done when
- Quick Select drag on an 8K document stays interactive.


## Resolution
Quick Select now flood-fills each stamp into the stroke mask but merges into the selection once per pointer event (new `publish()`), not once per stamp. The canvas-sized copy is only made in "set" mode (the only mode where `mergeMask` keeps a reference); add/subtract merge straight from the stroke mask. Merge cost per move is now O(canvas) once instead of O(canvas × stamps).
