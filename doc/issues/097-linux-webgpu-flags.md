# 097 · Check WebGPU enablement on Linux builds

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Stability (investigation) |
| Area | Electron main / Packaging |
| Verified | No — flagged by reviewer as worth checking, not a confirmed bug |

## Problem
The Linux AppImage/deb targets are configured without any Chromium flags. WebGPU on Linux may still require `--enable-unsafe-webgpu` and `--enable-features=Vulkan` depending on the Electron/Chromium version, in which case the app would fail to create a device (see [024](024-webgpu-init-error-silent.md)).

## Where
- `electron/main/index.ts` (app switches)
- electron-builder config (Linux targets)

## Suggested fix
Test the packaged Linux build on a Vulkan-capable machine. If WebGPU is unavailable, add the needed `app.commandLine.appendSwitch(...)` calls, gated on `process.platform === 'linux'`.

## Done when
- Packaged Linux build creates a WebGPU device on a supported GPU, or the need for flags is ruled out.

## Resolution
electron/main/index.ts appends enable-unsafe-webgpu and enable-features=Vulkan on Linux only. Not verified on real hardware — needs a check of the packaged AppImage/deb on a Vulkan-capable Linux machine; if device creation works without them, the flags can be removed.
