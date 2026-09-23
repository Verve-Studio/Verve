# 046 · DevTools IPC handler is registered in production builds

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | Low |
| Category | Security / Hygiene |
| Area | Electron main / IPC |
| Verified | No — reported by reviewer |

## Problem
`debug:openDevTools` has no `is.dev` guard, so any renderer code can open DevTools in the shipped app.

## Where
- `electron/main/ipc.ts:188-190`

## Suggested fix
Register it only when `is.dev`, or behind an explicit preference.

## Done when
- The handler is absent in production builds.

## Resolution
`debug:openDevTools` now returns without doing anything unless `is.dev`, so the renderer API stays the same and existing callers don't error.
