# 080 · History eviction recomputes total bytes on every loop pass

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Performance |
| Area | History |
| Verified | No — reported by reviewer |

## Problem
`evictUntilUnderCap` recomputes `getCurrentBytes()` over all entries and layers each loop pass: O(E²·L) when many entries are evicted at once.

## Where
- `src/core/store/historyStore.ts:233-243`

## Suggested fix
Compute once, then subtract the freed bytes per evicted entry (accounting for buffers shared between entries).

## Done when
- Lowering the history cap with 200 entries evicts instantly.


## Resolution
Fixed as part of 041: eviction builds per-store buffer reference counts once and subtracts freed bytes as entries are evicted, instead of recomputing the deduplicated total after every eviction.
