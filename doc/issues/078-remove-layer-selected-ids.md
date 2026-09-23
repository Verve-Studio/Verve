# 078 · `REMOVE_LAYER` leaves deleted ids in `selectedLayerIds`

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Low |
| Category | Correctness |
| Area | Store / Reducer |
| Verified | No — reported by reviewer |

## Problem
`REMOVE_LAYER` doesn't remove deleted ids from `selectedLayerIds`, so later merge/group actions receive dangling ids.

## Where
- `src/core/store/AppContext.tsx:489-497`

## Suggested fix
Filter `selectedLayerIds` against the removed ids in the reducer.

## Done when
- Select 3 layers, delete one, Merge Selected: only the 2 remaining are merged, with no errors.


## Resolution
REMOVE_LAYER filters every removed id (target, descendants, mask/adjustment children) out of selectedLayerIds, preserving the array identity when nothing changed.
