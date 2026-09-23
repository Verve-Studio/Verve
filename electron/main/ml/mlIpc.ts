import { ipcMain, BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { RefineParams, RefineResult } from '../matting'
import { cancelMlJobs, invalidateMlSession, runMlJob } from './mlHost'

type CheckResult = { ready: boolean; path: string | null; searchedPaths?: string[] }

/**
 * IPC surface for the AI features. Main only relays: model lookups, the RVM
 * download and all inference run in the ML worker process (`mlHost.ts`),
 * which keeps onnxruntime and the model code out of the main bundle.
 */
export function registerMlHandlers(): void {
  // ── ISNet (auto-mask) ─────────────────────────────────────────────────
  ipcMain.handle('isnet:check-model', () =>
    runMlJob<CheckResult>({ kind: 'check', model: 'isnet' }),
  )
  ipcMain.handle(
    'isnet:run',
    (_event, params: { rgba: Uint8Array; width: number; height: number }) =>
      runMlJob({ kind: 'isnet', params }),
  )
  ipcMain.handle('isnet:invalidate-session', () => invalidateMlSession('isnet'))

  // ── LaMa (inpaint) ────────────────────────────────────────────────────
  ipcMain.handle('inpaint:check-model', () =>
    runMlJob<CheckResult>({ kind: 'check', model: 'inpaint' }),
  )
  ipcMain.handle(
    'inpaint:run',
    (
      _event,
      params: { rgba: Uint8Array; mask: Uint8Array; width: number; height: number },
    ) => runMlJob({ kind: 'inpaint', params }),
  )
  ipcMain.handle('inpaint:invalidate-session', () => invalidateMlSession('inpaint'))

  // ── RVM (matting) ─────────────────────────────────────────────────────
  ipcMain.handle('matting:check-model', () =>
    runMlJob<CheckResult>({ kind: 'check', model: 'matting' }),
  )
  ipcMain.handle(
    'matting:download-model',
    async (event: IpcMainInvokeEvent): Promise<{ success: true } | { error: string }> => {
      const sender = BrowserWindow.fromWebContents(event.sender)
      try {
        await runMlJob({ kind: 'download-matting' }, (loaded, total) => {
          sender?.webContents.send('matting:download-progress', {
            progress: total > 0 ? loaded / total : 0,
            loaded,
            total,
          })
        })
        return { success: true }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
  ipcMain.handle(
    'matting:refine',
    (_event, params: RefineParams): Promise<RefineResult> =>
      runMlJob({ kind: 'matting', params }),
  )
  ipcMain.handle('matting:invalidate-session', () => invalidateMlSession('matting'))

  // ── Real-ESRGAN (upscale / restore) ───────────────────────────────────
  ipcMain.handle('upscale:list-models', () =>
    runMlJob({ kind: 'list-upscale-models' }),
  )
  ipcMain.handle('upscale:check-model', (_event, modelId: string) =>
    runMlJob<CheckResult>({ kind: 'check', model: 'upscale', modelId }),
  )
  ipcMain.handle(
    'upscale:run',
    (
      event: IpcMainInvokeEvent,
      params: {
        rgba: Uint8Array
        width: number
        height: number
        modelId: string
        targetWidth: number
        targetHeight: number
      },
    ) => {
      const sender = BrowserWindow.fromWebContents(event.sender)
      return runMlJob({ kind: 'upscale', params }, (loaded, total) => {
        sender?.webContents.send('upscale:progress', {
          progress: total > 0 ? loaded / total : 0,
          loaded,
          total,
        })
      })
    },
  )
  ipcMain.handle('upscale:invalidate-session', (_event, modelId?: string) =>
    invalidateMlSession('upscale', modelId),
  )

  // Abort whatever AI job is running (kills the worker; the next job starts
  // a fresh one).
  ipcMain.handle('ml:cancel', () => cancelMlJobs())
}
