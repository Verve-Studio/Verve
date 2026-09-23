# 090 · Lasso and Healing Brush copy the whole point array on every move

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Performance |
| Area | Tools / Lasso, HealingBrush |
| Verified | No — reported by reviewer |

## Problem
`[...points]` on every pointermove makes long paths quadratic.

## Where
- `src/core/tools/Lasso/Lasso.tsx:42`
- `src/core/tools/HealingBrush/HealingBrush.tsx:400`

## Suggested fix
Pass an append-only view (array + length / version counter), or throttle notifications to once per rAF.

## Done when
- A 10k-point lasso path stays smooth.


## Resolution
Lasso and Healing Brush pass their live append-only points array to setPending instead of copying it per move. SelectionStore.setPending no longer notifies: the only reader is the overlay rAF loop (polls every frame) and the subscribers depend on mask only; per-move notifies made InfoPanel rescan the whole mask on every pointer move.
