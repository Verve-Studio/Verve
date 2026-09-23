# 050 · Menu tree is rebuilt on every render

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | App shell / Menu |
| Verified | No — reported by reviewer |

## Problem
`effectiveSelectedIds` is a new `Set` each render and is in the `menuDeps` `useMemo` deps, so the memo never holds. Every render runs `buildMenuTree` and `collectActions`, and on macOS also `serializeTree` + `JSON.stringify`. Combined with [049](049-whole-app-rerender.md), this happens on every dispatch including each eyedropper move.

## Where
- `src/App.tsx:798, 1045`
- `src/core/services/useMacNativeMenu.ts:88-133`

## Suggested fix
`useMemo` the set on `[state.selectedLayerIds, state.activeLayerId]` and memoize the other per-render derived values in the deps list. Only re-send the native menu when the serialized tree changes.

## Done when
- `buildMenuTree` runs only when menu-relevant state changes.


## Resolution
Done so far:
- The menu tree was built twice per render on every platform. TopBar now skips it on macOS, and `useMacNativeMenu` skips it everywhere else, so it is built once per render.
- `effectiveSelectedIds` is memoised.

Completed:
- `menuDeps` is split in two:
  - Handlers are rebuilt every render into `menuHandlersNow`, typed from `MenuDeps`'s function keys, and exposed through permanently stable proxies (`stableHandlers`). They always call the latest closure, which also fixes the stale closures from dependencies the old list was missing, such as `handleCloseOthers` and `hasActiveDocument`.
  - A small memo covers only the displayed values: enable flags, pixel format, ICC profile, animation and view toggles, and recent files.
- TopBar is `React.memo`-wrapped, and its remaining props are stable.
- `buildMenuTree` / `collectActions` (plus `serializeTree` on macOS) now run only when a displayed menu value changes, or on the TopBar / `useMacNativeMenu` local subscriptions (LUTs, dock panels, display/proof state).
