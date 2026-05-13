import { ipcMain, app } from 'electron'
import { join, dirname } from 'node:path'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { IpcMainInvokeEvent } from 'electron'

// ─── ORT type stubs (mirror of matting.ts / upscale.ts) ──────────────────────

interface OrtTensor {
  readonly data: Float32Array | Int32Array | BigInt64Array | Uint8Array
  readonly dims: ReadonlyArray<number>
}

interface OrtTensorConstructor {
  new (type: 'float32', data: Float32Array, dims: number[]): OrtTensor
}

interface OrtInferenceSession {
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>
}

interface OrtModule {
  InferenceSession: {
    create(
      path: string,
      options?: {
        executionProviders?: Array<string | { name: string }>
        graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'all'
      },
    ): Promise<OrtInferenceSession>
  }
  Tensor: OrtTensorConstructor
}

const _require = createRequire(import.meta.url)
let _ort: OrtModule | null = null
function getOrt(): OrtModule {
  if (!_ort) _ort = _require('onnxruntime-node') as OrtModule
  return _ort
}

// ─── Model location ──────────────────────────────────────────────────────────
//
// Dev:   <root>/resources/models/isnet/isnet-general-use.onnx
// Prod:  process.resourcesPath/models/isnet/isnet-general-use.onnx
// User:  app.getPath('userData')/models/isnet/  (preferred when present)

const MODEL_FILE = 'isnet-general-use.onnx'

// Standard ISNet/DIS input size. The General-Use export is fixed at 1024×1024
// — we resize the input to this and resize the output mask back to source.
const ISNET_INPUT = 1024

function getBundledDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'models', 'isnet')
  }
  const devRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  return join(devRoot, 'resources', 'models', 'isnet')
}

function getUserDataDir(): string {
  return join(app.getPath('userData'), 'models', 'isnet')
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

async function resolveModelPath(): Promise<string | null> {
  const userPath = join(getUserDataDir(), MODEL_FILE)
  if (await fileExists(userPath)) return userPath
  const bundled = join(getBundledDir(), MODEL_FILE)
  if (await fileExists(bundled)) return bundled
  return null
}

// ─── Execution provider selection ────────────────────────────────────────────

function preferredProviders(): string[] {
  if (process.platform === 'win32') return ['dml', 'cpu']
  if (process.platform === 'darwin') return ['coreml', 'cpu']
  return ['cpu']
}

let session: OrtInferenceSession | null = null
let sessionProvider: string = 'cpu'

async function loadSession(): Promise<OrtInferenceSession> {
  if (session) return session
  const path = await resolveModelPath()
  if (!path) {
    throw new Error(
      `ISNet model "${MODEL_FILE}" not found. Place it in:\n` +
      `  ${getUserDataDir()}\n` +
      `or the bundled location:\n  ${getBundledDir()}`,
    )
  }
  const ort = getOrt()
  for (const ep of preferredProviders()) {
    try {
      session = await ort.InferenceSession.create(path, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      })
      sessionProvider = ep
      break
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[isnet] EP "${ep}" failed:`, err instanceof Error ? err.message : err)
    }
  }
  if (!session) throw new Error('Failed to create ONNX session for any execution provider')
  // eslint-disable-next-line no-console
  console.log(`[isnet] loaded via "${sessionProvider}". inputs=${session.inputNames.join(',')} outputs=${session.outputNames.join(',')}`)
  return session
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resize an RGBA buffer to `dstW × dstH` and pack into CHW float32 normalised
 * with mean=0.5, std=1.0 — the convention the official ISNet/DIS exports use.
 * Alpha is dropped (ISNet operates on RGB).
 */
function rgbaToChwNormalised(
  rgba: Uint8Array, srcW: number, srcH: number,
  dstW: number, dstH: number,
): Float32Array {
  const out = new Float32Array(3 * dstW * dstH)
  const plane = dstW * dstH
  const sx = srcW / dstW
  const sy = srcH / dstH
  for (let y = 0; y < dstH; y++) {
    const fy = (y + 0.5) * sy - 0.5
    const y0 = Math.max(0, Math.floor(fy))
    const y1 = Math.min(srcH - 1, y0 + 1)
    const wy = fy - y0
    for (let x = 0; x < dstW; x++) {
      const fx = (x + 0.5) * sx - 0.5
      const x0 = Math.max(0, Math.floor(fx))
      const x1 = Math.min(srcW - 1, x0 + 1)
      const wx = fx - x0
      const i00 = (y0 * srcW + x0) * 4
      const i01 = (y0 * srcW + x1) * 4
      const i10 = (y1 * srcW + x0) * 4
      const i11 = (y1 * srcW + x1) * 4
      const o = y * dstW + x
      for (let c = 0; c < 3; c++) {
        const top = rgba[i00 + c] * (1 - wx) + rgba[i01 + c] * wx
        const bot = rgba[i10 + c] * (1 - wx) + rgba[i11 + c] * wx
        const v = top * (1 - wy) + bot * wy
        // ISNet/DIS normalisation: x/255 - 0.5
        out[c * plane + o] = v / 255 - 0.5
      }
    }
  }
  return out
}

/** Bilinear-resize a single-channel float32 buffer to a uint8 mask buffer. */
function resizeMaskF32ToU8(
  src: Float32Array, srcW: number, srcH: number,
  dstW: number, dstH: number,
): Uint8Array {
  const out = new Uint8Array(dstW * dstH)
  const sx = srcW / dstW
  const sy = srcH / dstH
  for (let y = 0; y < dstH; y++) {
    const fy = (y + 0.5) * sy - 0.5
    const y0 = Math.max(0, Math.floor(fy))
    const y1 = Math.min(srcH - 1, y0 + 1)
    const wy = fy - y0
    for (let x = 0; x < dstW; x++) {
      const fx = (x + 0.5) * sx - 0.5
      const x0 = Math.max(0, Math.floor(fx))
      const x1 = Math.min(srcW - 1, x0 + 1)
      const wx = fx - x0
      const a00 = src[y0 * srcW + x0]
      const a01 = src[y0 * srcW + x1]
      const a10 = src[y1 * srcW + x0]
      const a11 = src[y1 * srcW + x1]
      const top = a00 * (1 - wx) + a01 * wx
      const bot = a10 * (1 - wx) + a11 * wx
      const v = top * (1 - wy) + bot * wy
      out[y * dstW + x] = v < 0 ? 0 : v > 1 ? 255 : Math.round(v * 255)
    }
  }
  return out
}

/** Inverse-sigmoid threshold detection: if the model emitted raw logits the
 *  range will span well beyond [0,1]; if it emitted post-sigmoid probabilities
 *  it stays within. Apply sigmoid only when needed. */
function maybeSigmoid(buf: Float32Array): void {
  let min = Infinity, max = -Infinity
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]
    if (v < min) min = v
    if (v > max) max = v
  }
  if (min >= 0 && max <= 1.001) return
  for (let i = 0; i < buf.length; i++) {
    buf[i] = 1.0 / (1.0 + Math.exp(-buf[i]))
  }
}

// ─── IPC handler registration ────────────────────────────────────────────────

export function registerIsnetHandlers(): void {
  ipcMain.handle(
    'isnet:check-model',
    async (): Promise<{ ready: boolean; path: string | null; searchedPaths: string[] }> => {
      const path = await resolveModelPath()
      return {
        ready: path !== null,
        path,
        searchedPaths: [join(getUserDataDir(), MODEL_FILE), join(getBundledDir(), MODEL_FILE)],
      }
    },
  )

  ipcMain.handle(
    'isnet:run',
    async (
      _event: IpcMainInvokeEvent,
      params: { rgba: Buffer; width: number; height: number },
    ): Promise<{ mask: Buffer; width: number; height: number; provider: string }> => {
      if (params.rgba.length !== params.width * params.height * 4) {
        throw new Error(`rgba length ${params.rgba.length} ≠ ${params.width}×${params.height}×4`)
      }
      const sess = await loadSession()
      const ort = getOrt()
      const rgba = new Uint8Array(params.rgba.buffer, params.rgba.byteOffset, params.rgba.byteLength)

      const chw = rgbaToChwNormalised(rgba, params.width, params.height, ISNET_INPUT, ISNET_INPUT)
      const feeds: Record<string, OrtTensor> = {}
      feeds[sess.inputNames[0]] = new ort.Tensor('float32', chw, [1, 3, ISNET_INPUT, ISNET_INPUT])
      const outputs = await sess.run(feeds)

      // ISNet exports often emit multiple side-outputs (1 high-res + 5 lower
      // supervision maps). The full-resolution mask is the first output.
      const maskTensor = outputs[sess.outputNames[0]]
      const maskF32 = new Float32Array(maskTensor.data as Float32Array)
      const maskH = maskTensor.dims[maskTensor.dims.length - 2]
      const maskW = maskTensor.dims[maskTensor.dims.length - 1]

      maybeSigmoid(maskF32)

      const upscaled = resizeMaskF32ToU8(maskF32, maskW, maskH, params.width, params.height)
      return {
        mask: Buffer.from(upscaled),
        width: params.width,
        height: params.height,
        provider: sessionProvider,
      }
    },
  )

  ipcMain.handle('isnet:invalidate-session', (): void => {
    session = null
  })
}
