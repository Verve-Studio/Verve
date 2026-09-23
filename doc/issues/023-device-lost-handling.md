# 023 · WebGPU device loss isn't handled; canvas freezes silently

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Stability |
| Area | GPU device |
| Verified | No — reported by reviewer |

## Problem
`GpuDevice.ts:34-36` only resets `sharedDevicePromise` on `device.lost`. The live renderer keeps the dead device, so every submit silently does nothing and the canvas freezes. `mapAsync` rejects, so export/merge/flatten throw raw `OperationError`s. There's no `uncapturederror` listener and no `pushErrorScope` anywhere in `src/`. Driver resets (e.g. Windows TDR from heavy effects, see [029](029-pixelate-gpu-timeout.md)–[032](032-motion-blur-gpu-timeout.md)) make this likely.

## Where
- `src/graphics/webgpu/device/GpuDevice.ts:34-36`

## Suggested fix
Register `device.lost` and `device.onuncapturederror` handlers that notify the user and trigger recovery: serialize the active tab (layer pixels are still in CPU `layer.data`), bump `canvasKey` to remount, and let the new mount request a new device.

## Done when
- Simulating device loss (`device.destroy()` from DevTools) shows a message and the canvas recovers with pixels intact.


## Resolution
`GpuDevice.ts` exposes `onGpuDeviceLost()` / `onGpuUncapturedError()` (device `lost` promise and `uncapturederror` event; intentional `destroyed` losses are ignored). The new `src/core/services/useGpuDeviceRecovery.ts` (wired in `App.tsx`) notifies the user, serializes the active tab's CPU-side pixels like a tab switch, bumps its `canvasKey`, and hands the data over as pending layer data, so the Canvas remounts on a fresh device. Uncaptured GPU errors are shown at most once per 10 s. Not tested against a real device loss. `device.destroy()` from DevTools won't trigger it (reason `destroyed` is ignored); use a driver reset or `chrome://gpucrash` instead.
