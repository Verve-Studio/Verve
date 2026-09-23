# 022 · Pixel copies for closed background tabs are never freed

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | Medium |
| Category | Stability / Memory |
| Area | Tabs / Stores |
| Verified | No — reported by reviewer |

## Problem
Switching away from a tab stores `.slice()` copies of every layer under `${tabId}:…` keys in the transfer stores. They're only freed by `take()` when that tab's Canvas mounts again. If a background tab is closed, its full-document copies stay forever. Same when `useGpuLayerInit` aborts early via `isStale()` before consuming them. The closed tab's history scope is also retained.

## Where
- `src/core/services/useTabs.ts:149-187, 301-312`
- `layerDataTransfer.ts` (f32/u8 transfer stores)

## Suggested fix
Add `dropPrefix(tabId + ":")` to both transfer stores and call it in `handleCloseTab` (and in `closeTabs`, see [001](001-close-all-tabs-closes-one.md)). Also call `tab.scope.history.clear({ recaptureSnapshot: false })` on close.

## Done when
- Opening and closing 10 large documents (without activating them again) returns JS heap usage to the baseline.


## Resolution
Added `dropPrefix()` to `f32TransferStore`/`u8TransferStore` and a silent `HistoryStore.dispose()` (doesn't fire the global `onClear`). `closeTabs` calls both for every closed tab. The `isStale()` early-abort case is not covered yet: entries for a live tab are consumed on its next mount.
