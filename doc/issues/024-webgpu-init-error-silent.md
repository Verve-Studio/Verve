# 024 · WebGPU initialization failure shows a blank canvas with no message

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | Medium |
| Category | Stability |
| Area | GPU device / Canvas |
| Verified | No — reported by reviewer |

## Problem
`Canvas.tsx:67-71` doesn't pass `onWebGPUError`. `useWebGPU.ts:52-61` forwards only `WebGPUUnavailableError` and just logs anything else (e.g. a pipeline-creation or memory throw inside the constructor).

## Where
- `src/ux/main/Canvas/Canvas.tsx:67-71`
- `src/core/services/useWebGPU.ts:52-61`

## Suggested fix
Forward every init error to `notificationStore` with a user-facing message (and GPU adapter info for bug reports).

## Done when
- A forced throw in the renderer constructor shows an error notification.


## Resolution
`useWebGPU` now reports every renderer-init failure through `notificationStore`. `WebGPUUnavailableError` still goes to `onWebGPUError` when a caller supplies one (none currently does), otherwise to a notification as well.
