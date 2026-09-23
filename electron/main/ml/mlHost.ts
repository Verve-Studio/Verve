import { utilityProcess, app } from 'electron'
import type { UtilityProcess } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MlJob, MlModel } from './mlJobs'
import type { MlPaths } from './paths'

/**
 * Main-process side of the ML worker (`mlWorker.ts`). All ONNX inference
 * runs in an Electron utility process so that:
 *  - the main event loop (window chrome, menus, dialogs, every other IPC)
 *    stays responsive during multi-second pre/post-processing, and
 *  - a native crash in onnxruntime / a GPU driver kills only the worker,
 *    not the app with the user's unsaved documents.
 *
 * The worker is started on first use, restarted on the next request after a
 * crash, and shut down after a period of inactivity. Shutting it down is
 * also what releases the models' native memory (100–200 MB of weights each,
 * plus DirectML/CoreML buffers competing with the canvas for VRAM).
 */

const IDLE_SHUTDOWN_MS = 3 * 60_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  onProgress?: (loaded: number, total: number) => void
}

type WorkerMessage =
  | { type: 'progress'; id: number; loaded: number; total: number }
  | { type: 'result'; id: number; result: unknown }
  | { type: 'error'; id: number; message: string }

let worker: UtilityProcess | null = null
let nextId = 1
const pending = new Map<number, Pending>()
let idleTimer: ReturnType<typeof setTimeout> | null = null
/** Set while we terminate the worker on purpose (idle / cancel). */
let stopping = false

function mlPathsForWorker(): MlPaths {
  return {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'),
    // Same derivation the ML modules used before: <root>/out/main → <root>.
    appRoot: join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
  }
}

function failAll(err: Error): void {
  for (const p of pending.values()) p.reject(err)
  pending.clear()
}

function ensureWorker(): UtilityProcess {
  if (worker) return worker
  const child = utilityProcess.fork(
    join(dirname(fileURLToPath(import.meta.url)), 'mlWorker.js'),
    [],
    { serviceName: 'Verve AI', stdio: 'inherit' },
  )
  child.on('message', (msg: WorkerMessage) => {
    const p = pending.get(msg.id)
    if (!p) return
    if (msg.type === 'progress') {
      p.onProgress?.(msg.loaded, msg.total)
      return
    }
    pending.delete(msg.id)
    if (msg.type === 'result') p.resolve(msg.result)
    else p.reject(new Error(msg.message))
    scheduleIdleShutdown()
  })
  child.on('exit', (code) => {
    if (worker === child) worker = null
    const intentional = stopping
    stopping = false
    if (pending.size > 0) {
      failAll(
        new Error(
          intentional
            ? 'The AI operation was cancelled.'
            : `The AI engine stopped unexpectedly (exit code ${code}). ` +
                'This is often a GPU driver or memory problem. Please try again.',
        ),
      )
    }
  })
  child.postMessage({ type: 'init', paths: mlPathsForWorker() })
  worker = child
  return child
}

function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (pending.size > 0 || !worker) return
    stopping = true
    worker.kill()
  }, IDLE_SHUTDOWN_MS)
}

/** Run a job in the worker. `onProgress` receives tile progress (upscale). */
export function runMlJob<T>(
  job: MlJob,
  onProgress?: (loaded: number, total: number) => void,
): Promise<T> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const child = ensureWorker()
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      onProgress,
    })
    child.postMessage({ type: 'run', id, job })
  })
}

/** Drop a model's session in the worker (no-op if the worker isn't running —
 *  a fresh worker loads models lazily anyway). */
export async function invalidateMlSession(
  model: MlModel,
  modelId?: string,
): Promise<void> {
  if (!worker) return
  await runMlJob({ kind: 'invalidate', model, modelId })
}

/** Abort every running AI job by terminating the worker. */
export function cancelMlJobs(): void {
  if (!worker) return
  stopping = true
  worker.kill()
}

/** Terminate the worker (app shutdown). */
export function shutdownMlHost(): void {
  if (idleTimer) clearTimeout(idleTimer)
  if (worker) {
    stopping = true
    worker.kill()
  }
}
