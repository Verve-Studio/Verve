# 015 · Opening files races with tab switches and other opens

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Stability / Data integrity |
| Area | Services / File ops, Tabs |
| Verified | No — reported by reviewer |

## Problem
`openFromPath` awaits file reads and decodes, then uses the `tabs`, `activeTabId` and `state` captured **before** the awaits and calls a non-functional `setTabs(updated)`.
- **Tab switch during open:** `serializeActiveTabPixels()` reads the live canvas (now the new tab) and stores those pixels under the stale `activeTabId`, so that tab's saved data becomes another document's pixels.
- **Two concurrent opens** (multi-file drag-drop, startup file + Open): the second `setTabs` drops the first new tab and its transfer-store data leaks.

## Where
- `src/core/services/useFileOps.ts:464-489, 574-599, 721-748, 809-834, 1037-1064`

## Suggested fix
After the awaits, read `activeTabIdRef.current` and live state; use `setTabs(prev => …)`. Serialize opens through a promise queue so only one open mutates tab state at a time.

## Done when
- Dropping 5 files at once opens 5 tabs.
- Switching tabs during a slow open never mixes pixels between documents.


## Resolution
All six "background active tab + append new tab" blocks in `useFileOps` now go through `addTabBackgroundingActive()`. It reads the active tab id and the snapshot/serialize helpers live (via `activeTabIdRef` and a latest-render ref), uses a functional `setTabs`, and keeps a tab's existing `savedLayerData` when its canvas has nothing to serialize yet. `openFromPath` is now a queue: opens run one at a time, each waiting for a React commit + paint before the next starts. `activeTabIdRef` is passed from `App.tsx`.
