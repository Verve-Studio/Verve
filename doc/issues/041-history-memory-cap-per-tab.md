# 041 · History memory cap isn't applied to new tabs; no overall budget

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | Medium |
| Category | Stability / Memory |
| Area | History / Stores |
| Verified | No — reported by reviewer |

## Problem
`setMemoryCapBytes` runs only on the scope active at mount (the bootstrap scope) and when preferences change. Every scope from `createDocumentScope()` uses the hard-coded 4 GB, so a user who set 1 GB is ignored in new tabs. The cap is per tab, so N tabs can hold N × cap.

## Where
- `src/core/services/useHistory.ts:336-341`
- `src/core/store/historyStore.ts:149`
- `src/core/store/scope.ts:40`

## Suggested fix
Set the cap in `createDocumentScope` from the current preference (or have `HistoryStore` read it). Enforce one global budget across all scopes (evict oldest entries of background tabs first).

## Done when
- With a 1 GB preference, total history memory across 3 tabs stays under 1 GB.


## Resolution
The history memory cap is now one budget shared by all open documents (module-level cap plus a registry of live `HistoryStore`s), so new tabs honour the preference automatically. When the total exceeds the cap, the globally oldest entries are evicted first, which means background tabs' older entries go before the active tab's; every document keeps at least one entry. Preferences → Memory now shows combined usage (`HistoryStore.totalBytes()`). Verified with a Node test of the eviction logic.
