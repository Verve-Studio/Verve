# 093 · Dock drag listeners are removed only on mouseup

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Stability |
| Area | UI / Dock |
| Verified | No — reported by reviewer |

## Problem
Document `mousemove` / `mouseup` listeners are added in handlers and removed only on mouseup. If the panel unmounts mid-drag or mouseup is lost (e.g. released outside the window), they leak and keep writing to `dockStore` for stale ids.

## Where
- `src/ux/main/RightPanel/Dock/ToolWindow.tsx:47-48, 81-82`
- `src/ux/main/RightPanel/Dock/DockRow.tsx:140-141`

## Suggested fix
Use `setPointerCapture` on the drag handle with pointer events, and add effect cleanup through a ref that removes any active listeners on unmount.

## Done when
- Unmounting a panel mid-drag leaves no document listeners behind.


## Resolution
New Dock/useDocumentDrag hook owns document mousemove/mouseup listeners: ends on mouseup, on a move with the primary button released (lost mouseup), or on window blur, and removes listeners without committing on unmount. ToolWindow (move + resize) and DockRow (row resize) use it.
