# 037 · All ML inference runs inside the Electron main process

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Stability / Performance |
| Area | Electron main / ML |
| Verified | No — reported by reviewer |

## Problem
`ort.InferenceSession.run` is async, but pre/post-processing is synchronous JS on the main event loop: Upscale does a full-size alpha resize over `upW*upH` pixels, a fill pass and `resizeRgbaBilinear`; Inpaint scans the whole mask for its bbox; ISNet resizes the mask to full res; Matting runs dilate/erode. While these run, all windows stop repainting chrome, menus/dialogs freeze and all other IPC waits, for seconds on large images. onnxruntime-node with DirectML/CoreML is native code in the main process: a driver fault, OOM abort or ORT assert kills the whole app including unsaved documents. There's no way to cancel a job.

## Where
- `electron/main/upscale.ts:371, 465`
- `electron/main/inpaint.ts:331, 355-365, 420`
- `electron/main/isnet.ts:680, 694`
- `electron/main/matting.ts:366-367, 373`

## Suggested fix
Move all four ML modules into an Electron `utilityProcess.fork()` worker. Send pixels as transferable ArrayBuffers over a `MessagePort`, add a cancel message, restart the worker on `exit`/crash and surface an error to the renderer. Main only brokers.

## Done when
- The UI stays responsive during an 8K upscale; killing the worker process shows an error and the next ML call works.


## Resolution
All AI work now runs in an Electron utility process:
- New `electron/main/mlWorker.ts` (second build entry in `electron.vite.config.ts`, with the Rolldown runtime split into its own chunk so the worker never loads `index.js`) runs model lookups, the RVM download and all inference.
- `electron/main/ml/mlHost.ts` in main starts the worker lazily, relays tile/download progress, rejects pending jobs with a clear message if it crashes, restarts it on the next request, and shuts it down after 3 min idle (releasing all native model memory).
- `ml/mlIpc.ts` keeps the existing IPC channels, and the renderer API is unchanged.
- The four model modules no longer import Electron; paths are injected via `ml/paths.ts`.
- Cancel: new `ml:cancel` IPC plus `window.api.ml.cancel()` (kills the worker; pending jobs reject as cancelled). Not yet wired to a UI button.

Verified in real Electron: ISNet ran via DirectML in the worker, then session release and a model check both worked.
