# 051 · Navigator re-renders 60×/s even when idle

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | UI / Navigator |
| Verified | No — reported by reviewer |

## Problem
A permanent rAF loop calls `setViewRect(getViewportRect())`, which returns a new object every frame, so React re-renders every frame. Each frame also does `querySelector`, two `getBoundingClientRect` calls (forced layout) and a `drawImage`, even when nothing changed.

## Where
- `src/ux/main/RightPanel/Navigator/Navigator.tsx:76-89`

## Suggested fix
Redraw only on mirror-update, scroll or zoom events. Compare values before `setState`, or set the view-rect's style directly through a ref.

## Done when
- With the app idle, the Navigator does no per-frame work (Performance panel shows no rAF activity from it).


## Resolution
The Navigator still checks once per animation frame, but it only copies the thumbnail when the canvas mirror has a new version (new `src/ux/main/Canvas/thumbnailMirror.ts` counter, bumped by `useCanvasRenderLoop` after each mirror update), and only calls `setViewRect` when the viewport rect actually changed. An idle Navigator no longer redraws or re-renders React 60×/s. Its two `getBoundingClientRect` reads per frame are cheap when layout is clean.
