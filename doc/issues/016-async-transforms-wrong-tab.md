# 016 · Long async operations apply to whichever tab is active when they finish

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Stability / Data integrity |
| Area | Services / Canvas transforms, AI ops |
| Verified | No — reported by reviewer |

## Problem
AI Rescale / Restore can take minutes. Afterwards they call `captureHistory` (into `activeScope()`, possibly another tab), `dispatch(RESIZE_CANVAS)` (the current document) and `setPendingLayerData` (global). `MainWindow` feeds `pendingLayerData ?? tab.savedLayerData` to whichever Canvas mounts next. Transfer-store keys are bare layer ids; every document has `"layer-0"`, so they collide across tabs.

## Where
- `src/core/services/useCanvasTransforms.ts:189-211, 306-328, 415-428, 705-728`
- `src/core/services/useHistory.ts:192`
- `MainWindow.tsx:432`

## Suggested fix
Capture `startTabId` and check `activeTabIdRef.current === startTabId` after each await (abort, or apply to the correct tab's scope). Store pending data as `{ tabId, data }`. Prefix all transfer-store keys with the tab id.

## Done when
- Start AI Upscale in tab A and switch to tab B: the result lands in tab A (or is cancelled with a message) and tab B is untouched.


## Resolution
The async transforms in `useCanvasTransforms` now check `activeTabIdRef` after their awaits via `abandonedAfterTabSwitch()`: Resize Image, AI Rescale, AI Restore, Rotate, Flip, Rotate/Flip Selected Layers. If the tab changed, the results are dropped (transfer-store entries freed) and a notification explains why; nothing touches the other tab's history, canvas size or pending data. All transform transfer-store keys are now prefixed `${tabId}:xform:` (14 sites). We chose cancelling over applying the result to a background tab, because that would need the unmounted tab's canvas for the "Before" history capture.
