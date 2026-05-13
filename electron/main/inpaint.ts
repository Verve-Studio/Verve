import { ipcMain, app } from 'electron'
import { join, dirname } from 'node:path'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { IpcMainInvokeEvent } from 'electron'

// ─── ORT type stubs (mirror of isnet.ts / upscale.ts) ────────────────────────

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

const MODEL_FILE = 'lama_fp32.onnx'

/**
 * LaMa working size. Most "lama_fp32.onnx" exports either fix the input to
 * 512×512 or accept dynamic shapes with multiples of 8 — feeding 512×512 is
 * the safe lowest common denominator and matches the size LaMa was trained
 * on (so resize-to-512 → inpaint → resize-back doesn't fight the model).
 */
const LAMA_INPUT = 512

function getBundledDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'models', 'lama')
  }
  const devRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  return join(devRoot, 'resources', 'models', 'lama')
}

function getUserDataDir(): string {
  return join(app.getPath('userData'), 'models', 'lama')
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
//
// LaMa is CPU-only on purpose. The model's FFC (Fast Fourier Convolution)
// layers produce complex-tensor shapes that DirectML's MatMul kernel rejects
// with "Non-zero status code … The parameter is incorrect", and the CoreML
// EP shows similar issues on Apple Silicon. CPU at 512×512 inference takes
// ~1–3 seconds end-to-end so the UX hit is minor compared to a hard crash.

function preferredProviders(): string[] {
  return ['cpu']
}

let session: OrtInferenceSession | null = null
let sessionProvider: string = 'cpu'

async function loadSession(): Promise<OrtInferenceSession> {
  if (session) return session
  const path = await resolveModelPath()
  if (!path) {
    throw new Error(
      `LaMa model "${MODEL_FILE}" not found. Place it in:\n` +
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
      console.warn(`[inpaint] EP "${ep}" failed:`, err instanceof Error ? err.message : err)
    }
  }
  if (!session) throw new Error('Failed to create ONNX session for any execution provider')
  // eslint-disable-next-line no-console
  console.log(`[inpaint] loaded via "${sessionProvider}". inputs=${session.inputNames.join(',')} outputs=${session.outputNames.join(',')}`)
  return session
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Bilinear-resize a region of an RGBA buffer (HWC uint8) into CHW float32 in
 * [0,1]. Used to feed cropped patches to the model. Alpha is dropped.
 */
function rgbaRegionToChw(
  rgba: Uint8Array, srcW: number, srcH: number,
  rx: number, ry: number, rw: number, rh: number,
  dstW: number, dstH: number,
): Float32Array {
  const out = new Float32Array(3 * dstW * dstH)
  const plane = dstW * dstH
  const sx = rw / dstW
  const sy = rh / dstH
  for (let y = 0; y < dstH; y++) {
    const fy = ry + (y + 0.5) * sy - 0.5
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(fy)))
    const y1 = Math.max(0, Math.min(srcH - 1, y0 + 1))
    const wy = fy - Math.floor(fy)
    for (let x = 0; x < dstW; x++) {
      const fx = rx + (x + 0.5) * sx - 0.5
      const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(fx)))
      const x1 = Math.max(0, Math.min(srcW - 1, x0 + 1))
      const wx = fx - Math.floor(fx)
      const i00 = (y0 * srcW + x0) * 4
      const i01 = (y0 * srcW + x1) * 4
      const i10 = (y1 * srcW + x0) * 4
      const i11 = (y1 * srcW + x1) * 4
      const o = y * dstW + x
      for (let c = 0; c < 3; c++) {
        const top = rgba[i00 + c] * (1 - wx) + rgba[i01 + c] * wx
        const bot = rgba[i10 + c] * (1 - wx) + rgba[i11 + c] * wx
        out[c * plane + o] = (top * (1 - wy) + bot * wy) / 255
      }
    }
  }
  return out
}

/**
 * Bilinear-resize a region of a single-channel uint8 mask into a CHW float32
 * mask in [0,1]. LaMa expects 1 = inpaint, 0 = keep.
 */
function maskRegionToChw(
  mask: Uint8Array, srcW: number, srcH: number,
  rx: number, ry: number, rw: number, rh: number,
  dstW: number, dstH: number,
  threshold: number,
): Float32Array {
  const out = new Float32Array(dstW * dstH)
  const sx = rw / dstW
  const sy = rh / dstH
  for (let y = 0; y < dstH; y++) {
    const fy = ry + (y + 0.5) * sy - 0.5
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(fy)))
    const y1 = Math.max(0, Math.min(srcH - 1, y0 + 1))
    const wy = fy - Math.floor(fy)
    for (let x = 0; x < dstW; x++) {
      const fx = rx + (x + 0.5) * sx - 0.5
      const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(fx)))
      const x1 = Math.max(0, Math.min(srcW - 1, x0 + 1))
      const wx = fx - Math.floor(fx)
      const a00 = mask[y0 * srcW + x0] >= threshold ? 1 : 0
      const a01 = mask[y0 * srcW + x1] >= threshold ? 1 : 0
      const a10 = mask[y1 * srcW + x0] >= threshold ? 1 : 0
      const a11 = mask[y1 * srcW + x1] >= threshold ? 1 : 0
      const top = a00 * (1 - wx) + a01 * wx
      const bot = a10 * (1 - wx) + a11 * wx
      out[y * dstW + x] = top * (1 - wy) + bot * wy
    }
  }
  return out
}

/**
 * Bilinear-sample a CHW float32 model output back into a destination uint8
 * RGBA region. Writes only where `mask[i] >= threshold` so unmodified pixels
 * stay bit-exact identical to the input — the model output isn't perfectly
 * pass-through outside the inpainted region.
 *
 * `outScale` is the per-channel multiplier that brings the model output into
 * the 0–255 byte range. Different LaMa exports use different conventions —
 * see `detectOutputScale` for how this is chosen.
 */
function compositePatchOver(
  dst: Uint8Array, dstW: number, dstH: number,
  patchChw: Float32Array, patchW: number, patchH: number,
  origMask: Uint8Array, threshold: number,
  px0: number, py0: number, pw: number, ph: number,
  outScale: number,
): void {
  const plane = patchW * patchH
  const sx = patchW / pw
  const sy = patchH / ph
  for (let y = 0; y < ph; y++) {
    const gy = py0 + y
    if (gy < 0 || gy >= dstH) continue
    const fy = (y + 0.5) * sy - 0.5
    const y0 = Math.max(0, Math.min(patchH - 1, Math.floor(fy)))
    const y1 = Math.max(0, Math.min(patchH - 1, y0 + 1))
    const wy = fy - Math.floor(fy)
    for (let x = 0; x < pw; x++) {
      const gx = px0 + x
      if (gx < 0 || gx >= dstW) continue
      if (origMask[gy * dstW + gx] < threshold) continue
      const fx = (x + 0.5) * sx - 0.5
      const x0 = Math.max(0, Math.min(patchW - 1, Math.floor(fx)))
      const x1 = Math.max(0, Math.min(patchW - 1, x0 + 1))
      const wx = fx - Math.floor(fx)
      const di = (gy * dstW + gx) * 4
      for (let c = 0; c < 3; c++) {
        const top =
          patchChw[c * plane + y0 * patchW + x0] * (1 - wx) +
          patchChw[c * plane + y0 * patchW + x1] * wx
        const bot =
          patchChw[c * plane + y1 * patchW + x0] * (1 - wx) +
          patchChw[c * plane + y1 * patchW + x1] * wx
        const v = (top * (1 - wy) + bot * wy) * outScale
        dst[di + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
      }
      // alpha stays as-is on the source; inpainting is RGB-only
    }
  }
}

/**
 * LaMa ONNX exports differ on output range — saic-mdal's reference export
 * emits [0,1] sRGB, the lama-cleaner export emits raw [0,255]. Decide from
 * the actual data: anything peaking well above 1.5 is the 0–255 convention.
 */
function detectOutputScale(out: Float32Array): { scale: number; min: number; max: number; mean: number } {
  let min = Infinity, max = -Infinity, sum = 0
  for (let i = 0; i < out.length; i++) {
    const v = out[i]
    if (v < min) min = v
    if (v > max) max = v
    sum += v
  }
  const mean = sum / out.length
  // If the peak is in roughly the [0,1] sRGB band, we still need to scale by
  // 255 going to bytes. If the peak is already byte-range, scale by 1.
  const scale = max > 1.5 ? 1.0 : 255.0
  return { scale, min, max, mean }
}

/** Compute the bounding box of pixels above `threshold` in a u8 mask. */
function maskBoundingBox(
  mask: Uint8Array, w: number, h: number, threshold: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] >= threshold) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 }
}

// ─── IPC handler ─────────────────────────────────────────────────────────────

const MASK_THRESHOLD = 8 // u8 values ≥ this count as "inpaint here"

export function registerInpaintHandlers(): void {
  ipcMain.handle(
    'inpaint:check-model',
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
    'inpaint:run',
    async (
      _event: IpcMainInvokeEvent,
      params: { rgba: Buffer; mask: Buffer; width: number; height: number },
    ): Promise<{ rgba: Buffer; width: number; height: number; provider: string }> => {
      const { width: w, height: h } = params
      if (params.rgba.length !== w * h * 4) {
        throw new Error(`rgba length ${params.rgba.length} ≠ ${w}×${h}×4`)
      }
      if (params.mask.length !== w * h) {
        throw new Error(`mask length ${params.mask.length} ≠ ${w}×${h}`)
      }

      const sess = await loadSession()
      const ort = getOrt()
      const rgba = new Uint8Array(params.rgba.buffer, params.rgba.byteOffset, params.rgba.byteLength)
      const mask = new Uint8Array(params.mask.buffer, params.mask.byteOffset, params.mask.byteLength)

      const bbox = maskBoundingBox(mask, w, h, MASK_THRESHOLD)
      if (!bbox) {
        // Nothing to inpaint — return the input unchanged.
        return {
          rgba: Buffer.from(rgba),
          width: w,
          height: h,
          provider: sessionProvider,
        }
      }

      // Add padding around the mask bbox so the model sees enough context.
      // 30% of the largest masked dimension, with a 64-pixel floor.
      const bw = bbox.x1 - bbox.x0
      const bh = bbox.y1 - bbox.y0
      const pad = Math.max(64, Math.round(0.3 * Math.max(bw, bh)))
      const cropX0 = Math.max(0, bbox.x0 - pad)
      const cropY0 = Math.max(0, bbox.y0 - pad)
      const cropX1 = Math.min(w, bbox.x1 + pad)
      const cropY1 = Math.min(h, bbox.y1 + pad)
      const cropW = cropX1 - cropX0
      const cropH = cropY1 - cropY0

      // Resize the crop to LaMa's working size.
      const imgChw = rgbaRegionToChw(
        rgba, w, h,
        cropX0, cropY0, cropW, cropH,
        LAMA_INPUT, LAMA_INPUT,
      )
      const maskChw = maskRegionToChw(
        mask, w, h,
        cropX0, cropY0, cropW, cropH,
        LAMA_INPUT, LAMA_INPUT,
        MASK_THRESHOLD,
      )

      // LaMa input naming convention: "image" + "mask". If the export uses
      // different names, fall back to positional.
      const feeds: Record<string, OrtTensor> = {}
      const imageTensor = new ort.Tensor('float32', imgChw, [1, 3, LAMA_INPUT, LAMA_INPUT])
      const maskTensor = new ort.Tensor('float32', maskChw, [1, 1, LAMA_INPUT, LAMA_INPUT])
      const imgName = sess.inputNames.find((n) => /image/i.test(n)) ?? sess.inputNames[0]
      const mskName = sess.inputNames.find((n) => /mask/i.test(n)) ?? sess.inputNames[1] ?? sess.inputNames[0]
      feeds[imgName] = imageTensor
      if (mskName !== imgName) feeds[mskName] = maskTensor

      const outputs = await sess.run(feeds)
      const outTensor = outputs[sess.outputNames[0]]
      const out = new Float32Array(outTensor.data as Float32Array)
      const outH = outTensor.dims[outTensor.dims.length - 2]
      const outW = outTensor.dims[outTensor.dims.length - 1]

      // Detect the model's output range. saic-mdal exports [0,1]; lama-cleaner
      // exports [0,255]. The composite step divides by the detected scale to
      // bring everything into uint8.
      const stats = detectOutputScale(out)
      // eslint-disable-next-line no-console
      console.log(
        `[inpaint] output dims=[${outTensor.dims.join(',')}] ` +
        `range=[${stats.min.toFixed(3)}, ${stats.max.toFixed(3)}] mean=${stats.mean.toFixed(3)} ` +
        `→ scale ×${stats.scale}`,
      )

      // Composite the model output back into a copy of the source — only the
      // pixels inside the original mask change.
      const result = new Uint8Array(rgba)
      compositePatchOver(
        result, w, h,
        out, outW, outH,
        mask, MASK_THRESHOLD,
        cropX0, cropY0, cropW, cropH,
        stats.scale,
      )

      return {
        rgba: Buffer.from(result),
        width: w,
        height: h,
        provider: sessionProvider,
      }
    },
  )

  ipcMain.handle('inpaint:invalidate-session', (): void => {
    session = null
  })
}
