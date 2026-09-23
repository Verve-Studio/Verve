# 001 · Close All / Close Others only closes one tab

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Correctness |
| Area | Tabs / App shell |
| Verified | Yes — confirmed in code during review |

## Problem
`handleCloseAll` / `handleCloseOthers` loop over ids and call `handleCloseTab(id)` for each. `handleCloseTab` computes `next = tabs.filter(...)` from its render-time closure and calls `setTabs(next)`. Every call in the loop uses the same stale `tabs`, so the last `setTabs` wins and only one tab is removed. If the active tab is among them, `switchToTab` also runs several times against inconsistent lists.

## Where
- `src/App.tsx:699-707`
- `src/core/services/useTabs.ts:301-312`

## Suggested fix
Add `closeTabs(ids: string[])` to `useTabs` that filters once (`setTabs(prev => prev.filter(t => !ids.includes(t.id)))`), picks a single fallback tab from the result, and calls `switchToTab` at most once. Route Close All / Close Others through it. Also free closed tabs' resources (see [022](022-closed-tab-transfer-store-leak.md)).

## Done when
- Close All with N tabs leaves zero tabs; Close Others leaves only the active tab.
- `switchToTab` runs at most once per operation.


## Resolution
Added `closeTabs(ids)` to `useTabs` (single `setTabs`, one fallback `switchToTab`); `handleCloseTab` delegates to it. Close All goes through `requireTransformDecision`. Closed tabs now also release their transfer-store entries and history (see 022).
