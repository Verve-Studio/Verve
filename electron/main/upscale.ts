import { ipcMain, app, BrowserWindow } from 'electron'
import { join, dirname } from 'node:path'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { IpcMainInvokeEvent } from 'electron'

// ─── ORT type stubs (mirror of sam.ts / matting.ts) ──────────────────────────

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

// ─── Model catalog ───────────────────────────────────────────────────────────
//
// Single hard-coded model for now. The dialog already exposes a "model" picker
// so the contract is in place — adding a second entry only requires another
// row here and dropping the file in resources/models/realesrgan/.

interface ModelDescriptor {
  id: string
  label: string
  file: string
  scale: 2 | 3 | 4
  /** Tile size in input pixels. Output tile = tile × scale per side. */
  tile: number
  /** Overlap (input pixels) on each tile edge to mask seam artifacts. */
  overlap: number
  /** If set, the model's input tensor has a fixed spatial size and we must
   *  always feed exactly `fixedInput × fixedInput`. The inner core is placed
   *  inside that window with surrounding context taken from neighbouring
   *  image pixels (shifted inward at edges, edge-replicated when the image
   *  is smaller than `fixedInput`). If null/undefined the model has a
   *  dynamic input shape and we just pad by `overlap`, clamped to image. */
  fixedInput?: number
}

const MODELS: ModelDescriptor[] = [
  {
    id: 'realesrgan-x4plus',
    label: 'Photos',
    file: 'RealESRGAN_x4plus.onnx',
    scale: 4,
    tile: 128,
    overlap: 16,
    fixedInput: 128,
  },
  {
    id: 'realesr-general-x4v3',
    label: 'General and detail preserving',
    file: 'realesr-general-x4v3.onnx',
    scale: 4,
    // Lighter SRVGGNetCompact backbone — handles bigger tiles per pass
    // without blowing memory, which is faster than running more 128-px
    // tiles with the same overlap cost.
    tile: 192,
    overlap: 16,
  },
  {
    id: 'realesrgan-x4plus-anime',
    label: 'Animation and line art',
    file: 'RealESRGAN_x4plus_anime_6B.onnx',
    scale: 4,
    // Same RRDBNet architecture as the photo model, also exported with a
    // fixed 128×128 input shape — must feed exactly that.
    tile: 128,
    overlap: 16,
    fixedInput: 128,
  },
]

function findModel(id: string): ModelDescriptor | null {
  return MODELS.find((m) => m.id === id) ?? null
}

// ─── Model paths ─────────────────────────────────────────────────────────────
//
// User-data takes precedence over the bundled copy so a user can drop a newer
// .onnx into their profile without reinstalling.

function getBundledDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'models', 'realesrgan')
  }
  const devRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  return join(devRoot, 'resources', 'models', 'realesrgan')
}

function getUserDataDir(): string {
  return join(app.getPath('userData'), 'models', 'realesrgan')
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

async function resolveModelPath(m: ModelDescriptor): Promise<string | null> {
  const userPath = join(getUserDataDir(), m.file)
  if (await fileExists(userPath)) return userPath
  const bundled = join(getBundledDir(), m.file)
  if (await fileExists(bundled)) return bundled
  return null
}

// ─── Execution provider selection ────────────────────────────────────────────
//
// onnxruntime-node ships DirectML on Windows and CoreML on macOS. If the
// hardware-accelerated provider fails to initialise (driver missing, GPU
// blacklisted, etc.) we transparently fall back to CPU instead of failing the
// whole feature.

function preferredProviders(): string[] {
  if (process.platform === 'win32') return ['dml', 'cpu']
  if (process.platform === 'darwin') return ['coreml', 'cpu']
  return ['cpu']
}

interface LoadedSession {
  session: OrtInferenceSession
  provider: string
}

const sessionCache = new Map<string, LoadedSession>()

async function loadSession(m: ModelDescriptor): Promise<LoadedSession> {
  const cached = sessionCache.get(m.id)
  if (cached) return cached

  const path = await resolveModelPath(m)
  if (!path) {
    throw new Error(
      `Upscale model "${m.file}" not found. Place it in:\n` +
      `  ${getUserDataDir()}\n` +
      `or the bundled location:\n  ${getBundledDir()}`,
    )
  }
  const ort = getOrt()
  const providers = preferredProviders()
  let session: OrtInferenceSession | null = null
  let usedProvider = 'cpu'
  const failures: string[] = []

  // Try providers in priority order. We can't ask ORT "is dml available?"
  // up-front, so we attempt the GPU EP first and fall back on throw.
  for (const ep of providers) {
    try {
      session = await ort.InferenceSession.create(path, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      })
      usedProvider = ep
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      failures.push(`${ep}: ${msg}`)
      // eslint-disable-next-line no-console
      console.warn(`[upscale] EP "${ep}" failed:`, msg)
    }
  }
  if (!session) {
    throw new Error(
      `Failed to create ONNX inference session for model "${m.file}" at ${path}. ` +
      `Attempted providers — ${failures.join(' | ')}`,
    )
  }
  // eslint-disable-next-line no-console
  console.log(`[upscale] loaded ${m.id} via "${usedProvider}". inputs=${session.inputNames.join(',')} outputs=${session.outputNames.join(',')}`)
  const loaded: LoadedSession = { session, provider: usedProvider }
  sessionCache.set(m.id, loaded)
  return loaded
}

// ─── Pixel helpers ───────────────────────────────────────────────────────────

/**
 * Pack a RGBA region (HWC uint8) into CHW float32 in [0,1]. Alpha is dropped
 * — Real-ESRGAN is RGB-only; alpha is handled separately via bilinear.
 */
function rgbaTileToChw(
  rgba: Uint8Array, srcW: number, srcH: number,
  rx: number, ry: number, w: number, h: number,
): Float32Array {
  const out = new Float32Array(3 * w * h)
  const plane = w * h
  for (let y = 0; y < h; y++) {
    const sy = Math.min(srcH - 1, Math.max(0, ry + y))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(srcW - 1, Math.max(0, rx + x))
      const si = (sy * srcW + sx) * 4
      const o = y * w + x
      out[o] = rgba[si] / 255
      out[o + plane] = rgba[si + 1] / 255
      out[o + 2 * plane] = rgba[si + 2] / 255
    }
  }
  return out
}

/**
 * Bilinear-resize a single-channel uint8 buffer.
 */
function resizeAlphaBilinear(
  src: Uint8Array, srcW: number, srcH: number,
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
      out[y * dstW + x] = Math.round(top * (1 - wy) + bot * wy)
    }
  }
  return out
}

/**
 * Bilinear-resize an HWC RGBA8 buffer. Used as the final step to bring the
 * model's native-scale output to the user's target dimensions.
 */
function resizeRgbaBilinear(
  src: Uint8Array, srcW: number, srcH: number,
  dstW: number, dstH: number,
): Uint8Array {
  if (srcW === dstW && srcH === dstH) return src
  const out = new Uint8Array(dstW * dstH * 4)
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
      const di = (y * dstW + x) * 4
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] * (1 - wx) + src[i01 + c] * wx
        const bot = src[i10 + c] * (1 - wx) + src[i11 + c] * wx
        out[di + c] = Math.round(top * (1 - wy) + bot * wy)
      }
    }
  }
  return out
}

// ─── Tiled inference ─────────────────────────────────────────────────────────
//
// Crop-center tiling: each tile is run on a padded region (inner core +
// `overlap` pixels of context on each side) but only the inner core of the
// model's output is written to the native-scale buffer. Neighbouring tiles
// pad into the same source pixels, so the model has full context across the
// seams without us ever needing to blend overlapping outputs.
//
// This avoids the float accumulator + weight buffer the original implementation
// kept at native scale — those were ~5× the size of the final uint8 image and
// were the source of the "Array buffer allocation failed" OOM on inputs above
// ~1080p.

interface UpscaleParams {
  rgba: Uint8Array
  width: number
  height: number
  modelId: string
  targetWidth: number
  targetHeight: number
}

interface ProgressEmit {
  (loaded: number, total: number): void
}

async function runUpscale(p: UpscaleParams, onProgress: ProgressEmit): Promise<Uint8Array> {
  const model = findModel(p.modelId)
  if (!model) throw new Error(`Unknown upscale model: ${p.modelId}`)
  if (p.rgba.length !== p.width * p.height * 4) {
    throw new Error(`rgba length ${p.rgba.length} ≠ ${p.width}×${p.height}×4`)
  }

  const { session } = await loadSession(model)
  const ort = getOrt()

  const scale = model.scale
  const upW = p.width * scale
  const upH = p.height * scale

  const tile = model.tile
  const overlap = model.overlap
  // `core` is the size of the non-overlap region we actually keep from each
  // tile's output. Tiles are positioned at `core` strides; their inputs get
  // padded by `overlap` on each side so the model sees enough context.
  const core = Math.max(1, tile - 2 * overlap)

  const innerTilesX = Math.max(1, Math.ceil(p.width / core))
  const innerTilesY = Math.max(1, Math.ceil(p.height / core))
  const totalTiles = innerTilesX * innerTilesY

  // Native-scale RGBA output. This is the single big allocation; for a 1080p
  // input upscaled 4× it's ~133 MB (down from ~660 MB with the old float
  // accumulator). Inputs that would need more native-scale memory than the
  // process can grant should pick a smaller target size — the final resize
  // step downsamples after.
  let upRgba: Uint8Array
  try {
    upRgba = new Uint8Array(upW * upH * 4)
  } catch (err) {
    throw new Error(
      `Failed to allocate ${upW}×${upH} upscale buffer ` +
      `(${((upW * upH * 4) / (1024 * 1024)).toFixed(0)} MB). ` +
      `Try a smaller source crop or lower target size.`,
      { cause: err instanceof Error ? err : undefined },
    )
  }

  // Pre-fill the alpha channel from a bilinear-resized copy of the input
  // alpha. RGB will be overwritten tile-by-tile below.
  const alphaIn = new Uint8Array(p.width * p.height)
  for (let i = 0; i < alphaIn.length; i++) alphaIn[i] = p.rgba[i * 4 + 3]
  const alphaUp = resizeAlphaBilinear(alphaIn, p.width, p.height, upW, upH)
  for (let i = 0; i < upW * upH; i++) {
    upRgba[i * 4 + 3] = alphaUp[i]
  }

  const fixed = model.fixedInput ?? null

  let tileIdx = 0
  for (let ty = 0; ty < innerTilesY; ty++) {
    const innerY = ty * core
    const innerH = Math.min(core, p.height - innerY)

    let feedY0: number
    let feedH: number
    if (fixed !== null) {
      feedH = fixed
      // Center the inner region in the feed, then clamp so the feed sits
      // entirely inside the image whenever the image is big enough.
      // Source pixels past `p.height` will be edge-replicated by
      // rgbaTileToChw when the image itself is smaller than `fixed`.
      const centered = innerY - Math.floor((feedH - innerH) / 2)
      feedY0 = p.height >= feedH
        ? Math.max(0, Math.min(p.height - feedH, centered))
        : 0
    } else {
      feedY0 = Math.max(0, innerY - overlap)
      const feedY1 = Math.min(p.height, innerY + innerH + overlap)
      feedH = feedY1 - feedY0
    }
    const innerInFeedY = innerY - feedY0

    for (let tx = 0; tx < innerTilesX; tx++) {
      const innerX = tx * core
      const innerW = Math.min(core, p.width - innerX)

      let feedX0: number
      let feedW: number
      if (fixed !== null) {
        feedW = fixed
        const centered = innerX - Math.floor((feedW - innerW) / 2)
        feedX0 = p.width >= feedW
          ? Math.max(0, Math.min(p.width - feedW, centered))
          : 0
      } else {
        feedX0 = Math.max(0, innerX - overlap)
        const feedX1 = Math.min(p.width, innerX + innerW + overlap)
        feedW = feedX1 - feedX0
      }
      const innerInFeedX = innerX - feedX0

      const chw = rgbaTileToChw(p.rgba, p.width, p.height, feedX0, feedY0, feedW, feedH)
      const feeds: Record<string, OrtTensor> = {}
      feeds[session.inputNames[0]] = new ort.Tensor('float32', chw, [1, 3, feedH, feedW])
      const out = await session.run(feeds)
      const outTensor = out[session.outputNames[0]]
      const od = outTensor.data as Float32Array
      const outH = outTensor.dims[outTensor.dims.length - 2]
      const outW = outTensor.dims[outTensor.dims.length - 1]
      const plane = outW * outH

      // Inner region in the feed output's coordinate space.
      const outInnerX0 = innerInFeedX * scale
      const outInnerY0 = innerInFeedY * scale
      const outInnerW = innerW * scale
      const outInnerH = innerH * scale

      // Destination origin in the native-scale RGBA buffer.
      const dstX0 = innerX * scale
      const dstY0 = innerY * scale

      for (let y = 0; y < outInnerH; y++) {
        const gy = dstY0 + y
        if (gy < 0 || gy >= upH) continue
        const srcRow = (outInnerY0 + y) * outW + outInnerX0
        const dstRow = (gy * upW + dstX0) * 4
        for (let x = 0; x < outInnerW; x++) {
          const si = srcRow + x
          const di = dstRow + x * 4
          const r = od[si] * 255
          const g = od[si + plane] * 255
          const b = od[si + 2 * plane] * 255
          upRgba[di]     = r < 0 ? 0 : r > 255 ? 255 : Math.round(r)
          upRgba[di + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g)
          upRgba[di + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b)
          // alpha already filled
        }
      }

      tileIdx++
      onProgress(tileIdx, totalTiles)
    }
  }

  // Final resize from model-native (scale×) to user-requested target.
  return resizeRgbaBilinear(upRgba, upW, upH, p.targetWidth, p.targetHeight)
}

// ─── IPC handler registration ────────────────────────────────────────────────

export function registerUpscaleHandlers(): void {
  ipcMain.handle('upscale:list-models', (): Array<{ id: string; label: string; scale: number }> => {
    return MODELS.map((m) => ({ id: m.id, label: m.label, scale: m.scale }))
  })

  ipcMain.handle(
    'upscale:check-model',
    async (_event, modelId: string): Promise<{ ready: boolean; path: string | null; searchedPaths: string[] }> => {
      const m = findModel(modelId)
      if (!m) return { ready: false, path: null, searchedPaths: [] }
      const path = await resolveModelPath(m)
      return {
        ready: path !== null,
        path,
        searchedPaths: [join(getUserDataDir(), m.file), join(getBundledDir(), m.file)],
      }
    },
  )

  ipcMain.handle(
    'upscale:run',
    async (
      event: IpcMainInvokeEvent,
      params: {
        rgba: Buffer
        width: number
        height: number
        modelId: string
        targetWidth: number
        targetHeight: number
      },
    ): Promise<{ rgba: Buffer; width: number; height: number; provider: string }> => {
      const sender = BrowserWindow.fromWebContents(event.sender)
      const emit = (loaded: number, total: number): void => {
        sender?.webContents.send('upscale:progress', {
          progress: total > 0 ? loaded / total : 0,
          loaded,
          total,
        })
      }
      const rgbaIn = new Uint8Array(params.rgba.buffer, params.rgba.byteOffset, params.rgba.byteLength)
      const result = await runUpscale(
        {
          rgba: rgbaIn,
          width: params.width,
          height: params.height,
          modelId: params.modelId,
          targetWidth: params.targetWidth,
          targetHeight: params.targetHeight,
        },
        emit,
      )
      const loaded = sessionCache.get(params.modelId)
      return {
        rgba: Buffer.from(result),
        width: params.targetWidth,
        height: params.targetHeight,
        provider: loaded?.provider ?? 'cpu',
      }
    },
  )

  ipcMain.handle('upscale:invalidate-session', (_event, modelId?: string): void => {
    if (modelId) sessionCache.delete(modelId)
    else sessionCache.clear()
  })
}
