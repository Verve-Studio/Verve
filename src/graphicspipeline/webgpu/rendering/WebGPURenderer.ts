import {
  createGpuTexture,
  uploadTextureData,
  uploadTexturePatch,
  uploadF32TextureData,
  uploadF32TexturePatch,
  createUniformBuffer,
  createReadbackBuffer,
  createVertexBuffer,
  writeUniformBuffer,
} from '../utils'
import {
  COMPOSITE_SHADER,
  CHECKER_SHADER,
  BLIT_SHADER,
} from '../shaders/shaders'
import { AdjustmentEncoder } from '../AdjustmentEncoder'
import { initFilterCompute } from '../compute/filterCompute'
import { initGrabCutCompute } from '../compute/grabcutCompute'

// ─── Re-export all public types from the types module ─────────────────────────
// All existing import sites use '@/webgpu/WebGPURenderer' — this keeps them working.
export type {
  GpuLayer,
  AdjustmentRenderOp,
  RenderPlanEntry,
  ColorBalancePassParams,
  BlackAndWhitePassParams,
  SelectiveColorPassParams,
  CurvesPassParams,
  ColorGradingPassParams,
} from '../types'
export { BLEND_MODE_INDEX, WebGPUUnavailableError } from '../types'

import type { GpuLayer, RenderPlanEntry, AdjustmentRenderOp } from '../types'
import { BLEND_MODE_INDEX, WebGPUUnavailableError } from '../types'
import type { PixelFormat, RGBAColor } from '@/types'

// ─── Render cache helpers ─────────────────────────────────────────────────────

/**
 * Produces a stable string key for a single AdjustmentRenderOp, excluding GPU
 * objects (`selMaskLayer`, `luts`) and substituting content-tracked surrogates.
 * Used to detect params changes for the adj-group output cache.
 */
function serializeAdjOp(op: AdjustmentRenderOp): string {
  const parts: string[] = [`${op.kind}|${op.layerId}|${op.visible ? 1 : 0}`]
  if (op.selMaskLayer) parts.push(`selV:${op.selMaskLayer.contentVersion}`)
  const record = op as Record<string, unknown>
  for (const [k, v] of Object.entries(record)) {
    if (k === 'kind' || k === 'layerId' || k === 'visible' || k === 'selMaskLayer' || k === 'luts') continue
    if (v instanceof Float32Array) {
      parts.push(`${k}:${Array.from(v).join(',')}`)
    } else if (typeof v === 'object' && v !== null) {
      try { parts.push(`${k}:${JSON.stringify(v)}`) } catch { parts.push(`${k}:[object]`) }
    } else {
      parts.push(`${k}:${v}`)
    }
  }
  return parts.join('~')
}

/** Stable key for a list of adjustment ops — used as the params portion of the group cache key. */
function computeAdjGroupParamsKey(adjustments: AdjustmentRenderOp[]): string {
  return adjustments.map(serializeAdjOp).join('§')
}

// ─── Full-canvas quad (two triangles) ─────────────────────────────────────────

const QUAD_POSITIONS = (w: number, h: number): Float32Array =>
  new Float32Array([0, 0, w, 0, 0, h, 0, h, w, 0, w, h])

const QUAD_UVS = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1])

// ─── Renderer ─────────────────────────────────────────────────────────────────

export class WebGPURenderer {
  private readonly device: GPUDevice
  private readonly context: GPUCanvasContext
  private readonly sampler: GPUSampler

  // Render pipelines
  private readonly compositePipeline: GPURenderPipeline  // renders to rgba8unorm internal textures
  private readonly compositeBGL: GPUBindGroupLayout
  private readonly checkerPipeline: GPURenderPipeline    // renders to screen (canvasFormat)
  private readonly blitPipeline: GPURenderPipeline       // renders to screen (canvasFormat)
  private readonly blitBGL: GPUBindGroupLayout

  // Adjustment compute encoder (owns all 25 compute pipelines + texture caches)
  private readonly adjEncoder: AdjustmentEncoder

  // Shared vertex/tex-coord buffers
  private readonly texCoordBuffer: GPUBuffer

  // Pre-allocated per-frame reusable buffers and bind groups (avoids alloc/destroy on the render hot path)
  private readonly canvasQuadVertBuf: GPUBuffer
  private readonly frameUniformBuf: GPUBuffer    // [w, h, 0, 0] — shared by blit and composite-resolution
  private readonly checkerUniformBuf: GPUBuffer
  private checkerBindGroup!: GPUBindGroup

  // Ping-pong textures
  private pingTex: GPUTexture
  private pongTex: GPUTexture
  private groupPingTex: GPUTexture
  private groupPongTex: GPUTexture

  // Temporary GPU buffers accumulated during composite encoding; flushed after submit.
  private pendingDestroyBuffers: GPUBuffer[] = []
  // Temporary GPU textures for isolated group compositing; flushed after submit.
  private pendingDestroyTextures: GPUTexture[] = []

  // Reusable per-composite (uniform, vertex) buffer pool. encodeCompositeLayer would
  // otherwise allocate two GPUBuffers (64-byte uniform + 48-byte vertex quad) per layer
  // per frame. At 60+ fps with N layers, that's hundreds of allocations/sec churning the
  // WebGPU driver. The pool grows once to historic peak and is then reused indefinitely.
  private compositeBufferPool: { unif: GPUBuffer; pos: GPUBuffer }[] = []
  private compositeBufferIndex = 0

  // ─── Render cache ──────────────────────────────────────────────────────────
  // Per-adjustment-group output textures: skip re-running adjustment passes when
  // the base layer's pixel content, position, mask, and params are all unchanged.
  // Key = parentLayerId. Only used during screen-preview renderPlan() calls.
  private adjGroupCache = new Map<string, {
    baseContentVersion: number
    offsetX: number
    offsetY: number
    baseMaskVersion: number  // -1 when there is no base mask
    paramsKey: string
    tex: GPUTexture
  }>()
  // Per standalone AdjustmentRenderOp (group-scoped effects: bloom, halation, etc.)
  // output cache. Keyed by op.layerId. The cache hits when the accumulated input
  // (everything composited before this op in the plan) and the op params are
  // both unchanged — in which case we copy from the cached texture instead of
  // re-running the (potentially multi-pass) compute pipeline.
  private standaloneOpCache = new Map<string, {
    inputFp: string
    paramsKey: string
    tex: GPUTexture
  }>()
  // True while encoding a screen-preview renderPlan() — enables the adj-group cache.
  private adjGroupCacheEnabled = false
  // When true (e.g. during a whole-layer drag), standalone AdjustmentRenderOps
  // (bloom, halation, glow, drop-shadow, etc.) are skipped so the compositor
  // only re-runs them once on pointer-up. Layers with per-layer color adjustments
  // still render correctly because the adj-group cache handles those separately.
  private previewMode = false

  /** Enable/disable preview mode. Call with true at drag start, false on pointer-up. */
  setPreviewMode(enabled: boolean): void {
    this.previewMode = enabled
  }

  readonly pixelWidth: number
  readonly pixelHeight: number
  private readonly internalFormat: GPUTextureFormat
  private readonly pixelFormat: PixelFormat
  deferFlush = false

  // ─── Factory ────────────────────────────────────────────────────────────────

  static async create(
    canvas: HTMLCanvasElement,
    pixelWidth: number,
    pixelHeight: number,
    pixelFormat: PixelFormat = 'rgba8',
  ): Promise<WebGPURenderer> {
    if (!navigator.gpu) {
      throw new WebGPUUnavailableError(
        'WebGPU is not available in this environment. PixelShop requires WebGPU to run.'
      )
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) {
      throw new WebGPUUnavailableError(
        'WebGPU adapter could not be obtained. Your GPU driver may not support WebGPU.'
      )
    }
    const device = await adapter.requestDevice()
    const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null
    if (!ctx) {
      throw new WebGPUUnavailableError('Failed to obtain WebGPU canvas context.')
    }
    const format = navigator.gpu.getPreferredCanvasFormat()
    ctx.configure({ device, format, alphaMode: 'premultiplied' })
    const internalFormat: GPUTextureFormat = pixelFormat === 'rgba32f' ? 'rgba32float' : 'rgba8unorm'
    return new WebGPURenderer(device, ctx, format, pixelWidth, pixelHeight, internalFormat, pixelFormat)
  }

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    canvasFormat: GPUTextureFormat,
    pixelWidth: number,
    pixelHeight: number,
    internalFormat: GPUTextureFormat,
    pixelFormat: PixelFormat,
  ) {
    this.device = device
    this.context = context
    this.pixelWidth = pixelWidth
    this.pixelHeight = pixelHeight
    this.internalFormat = internalFormat
    this.pixelFormat = pixelFormat

    // Samplers
    this.sampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })

    // Shared vertex buffers
    this.texCoordBuffer = createVertexBuffer(device, QUAD_UVS)

    // Pre-allocate static per-frame buffers
    this.canvasQuadVertBuf = createVertexBuffer(device, QUAD_POSITIONS(pixelWidth, pixelHeight))
    this.frameUniformBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, this.frameUniformBuf, new Float32Array([pixelWidth, pixelHeight, 0, 0]))
    const cuData = new DataView(new ArrayBuffer(64))
    cuData.setFloat32( 0, 8.0,         true)  // tileSize
    cuData.setFloat32(16, 0.549,       true); cuData.setFloat32(20, 0.549, true); cuData.setFloat32(24, 0.549, true)  // colorA
    cuData.setFloat32(28, 0.0,         true)  // _pad0
    cuData.setFloat32(32, 0.392,       true); cuData.setFloat32(36, 0.392, true); cuData.setFloat32(40, 0.392, true)  // colorB
    cuData.setFloat32(44, 0.0,         true)  // _pad1
    cuData.setFloat32(48, pixelWidth,  true); cuData.setFloat32(52, pixelHeight, true)  // resolution
    this.checkerUniformBuf = createUniformBuffer(device, 64)
    writeUniformBuffer(device, this.checkerUniformBuf, cuData.buffer)

    // Ping-pong textures
    const texUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT
    this.pingTex      = this.createPingPongTex(pixelWidth, pixelHeight, texUsage)
    this.pongTex      = this.createPingPongTex(pixelWidth, pixelHeight, texUsage)
    this.groupPingTex = this.createPingPongTex(pixelWidth, pixelHeight, texUsage)
    this.groupPongTex = this.createPingPongTex(pixelWidth, pixelHeight, texUsage)

    // Render pipelines — composite targets internal rgba8unorm textures; checker/blit target the screen
    // Build explicit BGLs first so composite/blit pipelines accept rgba32float layer textures
    // (auto-layout would infer sampleType:'float', which is incompatible with rgba32float).
    this.compositeBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'non-filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        // Vertex stage reads `res` for NDC conversion in vs_composite.
        { binding: 5, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    })
    this.blitBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'non-filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false } },
        // Vertex stage reads `u.resolution` for NDC conversion in vs_blit.
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    })
    this.compositePipeline = this.createCompositePipeline(this.internalFormat, this.compositeBGL)
    this.checkerPipeline   = this.createCheckerPipeline(canvasFormat)
    this.blitPipeline      = this.createBlitPipeline(canvasFormat, this.blitBGL)
    this.checkerBindGroup  = device.createBindGroup({
      layout: this.checkerPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.checkerUniformBuf } }],
    })

    // Adjustment compute encoder (owns all 25 compute pipelines + texture caches)
    this.adjEncoder = new AdjustmentEncoder(device, pixelWidth, pixelHeight)

    initFilterCompute(this.device, this.pixelWidth, this.pixelHeight, this.internalFormat)
    initGrabCutCompute(this.device)
  }

  get internalTextureFormat(): GPUTextureFormat { return this.internalFormat }

  // ─── Pipeline factories ─────────────────────────────────────────────────────

  private createPingPongTex(w: number, h: number, usage: GPUTextureUsageFlags): GPUTexture {
    return this.device.createTexture({
      size: { width: w, height: h },
      format: this.internalFormat,
      usage,
    })
  }

  private createCompositePipeline(format: GPUTextureFormat, bgl: GPUBindGroupLayout): GPURenderPipeline {
    const module = this.device.createShaderModule({ code: COMPOSITE_SHADER })
    return this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: {
        module,
        entryPoint: 'vs_composite',
        buffers: [
          { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }] },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_composite',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    })
  }

  private createCheckerPipeline(format: GPUTextureFormat): GPURenderPipeline {
    const module = this.device.createShaderModule({ code: CHECKER_SHADER })
    return this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs_checker',
        buffers: [
          { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }] },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_checker',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    })
  }

  private createBlitPipeline(format: GPUTextureFormat, bgl: GPUBindGroupLayout): GPURenderPipeline {
    const module = this.device.createShaderModule({ code: BLIT_SHADER })
    return this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: {
        module,
        entryPoint: 'vs_blit',
        buffers: [
          { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }] },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_blit',
        targets: [{
          format,
          // Source-over blending for premultiplied-alpha source (straight-alpha src texture
          // is treated as premultiplied because rgba8unorm stores un-associated alpha,
          // but for Porter-Duff OVER on top of the checkerboard we need:
          //   out = src + dst * (1 - src.a)
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    })
  }

  // ─── Layer management ───────────────────────────────────────────────────────

  createLayer(
    id: string,
    name: string,
    lw = this.pixelWidth,
    lh = this.pixelHeight,
    ox = 0,
    oy = 0,
    format: PixelFormat = 'rgba8',
  ): GpuLayer {
    const data: Uint8Array | Float32Array =
      format === 'rgba32f'
        ? new Float32Array(lw * lh * 4)
        : format === 'indexed8'
          ? new Uint8Array(lw * lh)
          : new Uint8Array(lw * lh * 4)
    const textureFormat: GPUTextureFormat =
      format === 'rgba32f' ? 'rgba32float' : 'rgba8unorm'
    const texture = createGpuTexture(this.device, lw, lh, null, textureFormat)
    return { id, name, texture, data, format, layerWidth: lw, layerHeight: lh, offsetX: ox, offsetY: oy, opacity: 1, visible: true, blendMode: 'normal', dirtyRect: null, contentVersion: 0 }
  }

  flushLayer(layer: GpuLayer, palette?: RGBAColor[]): void {
    if (this.deferFlush) return
    layer.contentVersion++

    if (layer.format === 'indexed8') {
      const expanded = this.expandIndicesToRgba8(layer.data as Uint8Array, palette ?? [])
      uploadTextureData(this.device, layer.texture, layer.layerWidth, layer.layerHeight, expanded)
      return
    }

    if (layer.format === 'rgba32f') {
      if (layer.dirtyRect) {
        const { lx, ly, rx, ry } = layer.dirtyRect
        layer.dirtyRect = null
        uploadF32TexturePatch(this.device, layer.texture, layer.layerWidth, lx, ly, rx - lx, ry - ly, layer.data as Float32Array)
      } else {
        uploadF32TextureData(this.device, layer.texture, layer.layerWidth, layer.layerHeight, layer.data as Float32Array)
      }
      return
    }

    // rgba8 — existing path
    if (layer.dirtyRect) {
      const { lx, ly, rx, ry } = layer.dirtyRect
      layer.dirtyRect = null
      uploadTexturePatch(this.device, layer.texture, layer.layerWidth, lx, ly, rx - lx, ry - ly, layer.data as Uint8Array)
    } else {
      uploadTextureData(this.device, layer.texture, layer.layerWidth, layer.layerHeight, layer.data as Uint8Array)
    }
  }

  private expandIndicesToRgba8(indices: Uint8Array, palette: RGBAColor[]): Uint8Array {
    const out = new Uint8Array(indices.length * 4)
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i]
      if (idx < palette.length) {
        const c = palette[idx]
        out[i * 4]     = c.r
        out[i * 4 + 1] = c.g
        out[i * 4 + 2] = c.b
        out[i * 4 + 3] = c.a
      }
      // else: idx >= palette.length → [0,0,0,0] (already zero from new Uint8Array)
    }
    return out
  }

  replaceLayerData(
    layer: GpuLayer,
    newData: Uint8Array | Float32Array,
    newFormat: PixelFormat,
    palette?: RGBAColor[],
  ): void {
    layer.texture.destroy()
    const textureFormat: GPUTextureFormat =
      newFormat === 'rgba32f' ? 'rgba32float' : 'rgba8unorm'
    layer.texture = createGpuTexture(this.device, layer.layerWidth, layer.layerHeight, null, textureFormat)
    layer.data = newData
    layer.format = newFormat
    layer.dirtyRect = null
    this.flushLayer(layer, palette)
  }

  destroyLayer(layer: GpuLayer): void {
    layer.texture.destroy()
    const cached = this.adjGroupCache.get(layer.id)
    if (cached) {
      cached.tex.destroy()
      this.adjGroupCache.delete(layer.id)
    }
    const cachedSO = this.standaloneOpCache.get(layer.id)
    if (cachedSO) {
      cachedSO.tex.destroy()
      this.standaloneOpCache.delete(layer.id)
    }
  }

  growLayerToFit(layer: GpuLayer, canvasX: number, canvasY: number, extraRadius = 0): boolean {
    // Never grow the layer beyond canvas bounds — pointer may be outside the canvas.
    if (
      canvasX + extraRadius < 0 || canvasX - extraRadius >= this.pixelWidth ||
      canvasY + extraRadius < 0 || canvasY - extraRadius >= this.pixelHeight
    ) return false

    const lx = canvasX - layer.offsetX - extraRadius
    const ly = canvasY - layer.offsetY - extraRadius
    const rx = canvasX - layer.offsetX + extraRadius
    const ry = canvasY - layer.offsetY + extraRadius

    const fitsX = lx >= 0 && rx < layer.layerWidth
    const fitsY = ly >= 0 && ry < layer.layerHeight
    if (fitsX && fitsY) return false

    const cx = this.pixelWidth  / 2
    const cy = this.pixelHeight / 2

    let newX = layer.offsetX
    let newY = layer.offsetY
    let newW = layer.layerWidth
    let newH = layer.layerHeight

    if (!fitsX) {
      while (canvasX - extraRadius < newX || canvasX + extraRadius >= newX + newW) {
        newW *= 2
        newX = Math.round(cx - newW / 2)
      }
    }
    if (!fitsY) {
      while (canvasY - extraRadius < newY || canvasY + extraRadius >= newY + newH) {
        newH *= 2
        newY = Math.round(cy - newH / 2)
      }
    }

    const copyX = layer.offsetX - newX
    const copyY = layer.offsetY - newY
    const textureFormat: GPUTextureFormat = layer.format === 'rgba32f' ? 'rgba32float' : 'rgba8unorm'

    let newData: Uint8Array | Float32Array
    if (layer.format === 'rgba32f') {
      newData = new Float32Array(newW * newH * 4)
      const stride = layer.layerWidth * 4
      for (let row = 0; row < layer.layerHeight; row++) {
        const srcOff = row * stride
        const dstOff = ((copyY + row) * newW + copyX) * 4
        ;(newData as Float32Array).set(
          (layer.data as Float32Array).subarray(srcOff, srcOff + stride),
          dstOff,
        )
      }
    } else if (layer.format === 'indexed8') {
      // indexed8: 1 byte per pixel; 255 = transparent sentinel
      newData = new Uint8Array(newW * newH)
      ;(newData as Uint8Array).fill(255)
      const stride = layer.layerWidth
      for (let row = 0; row < layer.layerHeight; row++) {
        const srcOff = row * stride
        const dstOff = (copyY + row) * newW + copyX
        ;(newData as Uint8Array).set(
          (layer.data as Uint8Array).subarray(srcOff, srcOff + stride),
          dstOff,
        )
      }
    } else {
      newData = new Uint8Array(newW * newH * 4)
      const stride = layer.layerWidth * 4
      for (let row = 0; row < layer.layerHeight; row++) {
        const srcOff = row * stride
        const dstOff = ((copyY + row) * newW + copyX) * 4
        ;(newData as Uint8Array).set(
          (layer.data as Uint8Array).subarray(srcOff, srcOff + stride),
          dstOff,
        )
      }
    }

    // Create new texture; for indexed8 the caller's flushLayer will upload correct RGBA content
    const newTex = createGpuTexture(this.device, newW, newH, null, textureFormat)
    if (layer.format === 'rgba32f') {
      uploadF32TextureData(this.device, newTex, newW, newH, newData as Float32Array)
    } else if (layer.format !== 'indexed8') {
      uploadTextureData(this.device, newTex, newW, newH, newData as Uint8Array)
    }

    layer.texture.destroy()
    layer.texture    = newTex
    layer.data       = newData
    layer.layerWidth  = newW
    layer.layerHeight = newH
    layer.offsetX    = newX
    layer.offsetY    = newY
    layer.dirtyRect  = null  // texture is fully up-to-date after grow
    layer.contentVersion++
    return true
  }

  // ─── Pixel operations (CPU-side, layer-local coords) ────────────────────────

  drawPixel(layer: GpuLayer, x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (x < 0 || x >= layer.layerWidth || y < 0 || y >= layer.layerHeight) return
    const i = (y * layer.layerWidth + x) * 4
    layer.data[i] = r; layer.data[i + 1] = g; layer.data[i + 2] = b; layer.data[i + 3] = a
  }

  erasePixel(layer: GpuLayer, x: number, y: number): void {
    this.drawPixel(layer, x, y, 0, 0, 0, 0)
  }

  samplePixel(layer: GpuLayer, x: number, y: number): [number, number, number, number] {
    if (x < 0 || x >= layer.layerWidth || y < 0 || y >= layer.layerHeight) return [0, 0, 0, 0]
    const i = (y * layer.layerWidth + x) * 4
    return [layer.data[i], layer.data[i + 1], layer.data[i + 2], layer.data[i + 3]]
  }

  canvasToLayer(layer: GpuLayer, canvasX: number, canvasY: number): { x: number; y: number } | null {
    const lx = canvasX - layer.offsetX
    const ly = canvasY - layer.offsetY
    if (lx < 0 || ly < 0 || lx >= layer.layerWidth || ly >= layer.layerHeight) return null
    return { x: lx, y: ly }
  }

  canvasToLayerUnchecked(layer: GpuLayer, canvasX: number, canvasY: number): { x: number; y: number } {
    return { x: canvasX - layer.offsetX, y: canvasY - layer.offsetY }
  }

  sampleCanvasPixel(layer: GpuLayer, canvasX: number, canvasY: number): [number, number, number, number] {
    return this.samplePixel(layer, canvasX - layer.offsetX, canvasY - layer.offsetY)
  }

  drawCanvasPixel(layer: GpuLayer, canvasX: number, canvasY: number, r: number, g: number, b: number, a: number): void {
    this.drawPixel(layer, canvasX - layer.offsetX, canvasY - layer.offsetY, r, g, b, a)
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────

  render(layers: GpuLayer[], maskMap?: Map<string, GpuLayer>): void {
    const plan: RenderPlanEntry[] = layers.map(layer => ({
      kind: 'layer' as const,
      layer,
      mask: maskMap?.get(layer.id),
    }))
    this.renderPlan(plan)
  }

  renderPlan(plan: RenderPlanEntry[]): void {
    const { device } = this
    const encoder = device.createCommandEncoder()

    this.adjGroupCacheEnabled = true
    const finalTex = this.encodePlanToComposite(encoder, plan)
    this.adjGroupCacheEnabled = false

    // Render to screen: checkerboard + blit
    const screenView = this.context.getCurrentTexture().createView()
    this.encodeCheckerboard(encoder, screenView)
    this.encodeBlitToView(encoder, finalTex, screenView)

    device.queue.submit([encoder.finish()])
    this.flushPendingDestroys()
  }

  // ─── Flatten / readback ─────────────────────────────────────────────────────

  readLayerPixels(layer: GpuLayer): Uint8Array | Float32Array {
    return layer.data.slice() as Uint8Array | Float32Array
  }

  async readFlattenedPixels(layers: GpuLayer[], maskMap?: Map<string, GpuLayer>): Promise<Uint8Array | Float32Array> {
    const plan: RenderPlanEntry[] = layers.map(layer => ({
      kind: 'layer' as const,
      layer,
      mask: maskMap?.get(layer.id),
    }))
    return this.readFlattenedPlan(plan)
  }

  async readFlattenedPlan(plan: RenderPlanEntry[]): Promise<Uint8Array | Float32Array> {
    const { device, pixelWidth: w, pixelHeight: h } = this
    const encoder = device.createCommandEncoder()
    const finalTex = this.encodePlanToComposite(encoder, plan)

    const bytesPerPixel = this.internalFormat === 'rgba32float' ? 16 : 4
    const alignedBpr = Math.ceil(w * bytesPerPixel / 256) * 256
    const readbuf = createReadbackBuffer(device, alignedBpr * h)
    encoder.copyTextureToBuffer(
      { texture: finalTex },
      { buffer: readbuf, bytesPerRow: alignedBpr, rowsPerImage: h },
      { width: w, height: h },
    )
    device.queue.submit([encoder.finish()])
    this.flushPendingDestroys()

    await readbuf.mapAsync(GPUMapMode.READ)
    const raw = readbuf.getMappedRange()
    const result = this.internalFormat === 'rgba32float'
      ? this.unpackF32Rows(new Float32Array(raw), w, h, alignedBpr / 4)
      : this.unpackRows(new Uint8Array(raw), w, h, alignedBpr)
    readbuf.unmap()
    readbuf.destroy()
    return result
  }

  async readAdjustmentInputPlan(plan: RenderPlanEntry[], adjustmentLayerId: string): Promise<Uint8Array | null> {
    const groupEntry = plan.find(
      (entry): entry is Extract<RenderPlanEntry, { kind: 'adjustment-group' }> =>
        entry.kind === 'adjustment-group' &&
        entry.adjustments.some(op => op.layerId === adjustmentLayerId)
    )
    if (!groupEntry) return null

    const targetIndex = groupEntry.adjustments.findIndex(op => op.layerId === adjustmentLayerId)
    if (targetIndex < 0) return null

    const { device, pixelWidth: w, pixelHeight: h } = this
    const encoder = device.createCommandEncoder()

    // Clear group textures
    this.encodeClearTexture(encoder, this.groupPingTex)
    this.encodeClearTexture(encoder, this.groupPongTex)

    let srcTex = this.groupPongTex
    let dstTex = this.groupPingTex

    const baseAsSource: GpuLayer = { ...groupEntry.baseLayer, opacity: 1, blendMode: 'normal' }
    this.encodeCompositeLayer(encoder, baseAsSource, srcTex, dstTex, groupEntry.baseMask)
    ;[srcTex, dstTex] = [dstTex, srcTex]

    for (let i = 0; i < targetIndex; i++) {
      const op = groupEntry.adjustments[i]
      if (!op.visible) continue
      this.adjEncoder.encode(encoder, op, srcTex, dstTex, this.internalFormat)
      ;[srcTex, dstTex] = [dstTex, srcTex]
    }

    const alignedBpr = Math.ceil(w * 4 / 256) * 256
    const readbuf = createReadbackBuffer(device, alignedBpr * h)
    encoder.copyTextureToBuffer(
      { texture: srcTex },
      { buffer: readbuf, bytesPerRow: alignedBpr, rowsPerImage: h },
      { width: w, height: h },
    )
    device.queue.submit([encoder.finish()])
    this.flushPendingDestroys()

    await readbuf.mapAsync(GPUMapMode.READ)
    const result = this.unpackRows(new Uint8Array(readbuf.getMappedRange()), w, h, alignedBpr)
    readbuf.unmap()
    readbuf.destroy()
    return result
  }

  // ─── Plan execution ─────────────────────────────────────────────────────────

  /** Remove per-row GPU alignment padding and return a tightly-packed RGBA buffer. */
  private unpackRows(src: Uint8Array, w: number, h: number, alignedBpr: number): Uint8Array {
    const packedBpr = w * 4
    if (alignedBpr === packedBpr) return src.slice()
    const out = new Uint8Array(packedBpr * h)
    for (let row = 0; row < h; row++) {
      out.set(src.subarray(row * alignedBpr, row * alignedBpr + packedBpr), row * packedBpr)
    }
    return out
  }

  /** Remove per-row GPU alignment padding for float32 readback and return a tightly-packed RGBA float buffer. */
  private unpackF32Rows(src: Float32Array, w: number, h: number, alignedStride: number): Float32Array {
    const packedStride = w * 4
    if (alignedStride === packedStride) return src.slice()
    const out = new Float32Array(packedStride * h)
    for (let row = 0; row < h; row++) {
      out.set(src.subarray(row * alignedStride, row * alignedStride + packedStride), row * packedStride)
    }
    return out
  }

  private encodePlanToComposite(
    encoder: GPUCommandEncoder,
    plan: RenderPlanEntry[],
  ): GPUTexture {
    this.compositeBufferIndex = 0
    this.encodeClearTexture(encoder, this.pingTex)
    this.encodeClearTexture(encoder, this.pongTex)
    const { src } = this.encodeSubPlan(encoder, plan, this.pongTex, this.pingTex, '')
    return src
  }

  /**
   * Lend out a (uniform, vertex) buffer pair from the pool. Buffers persist across frames;
   * the pool grows on demand and the index is reset at the start of each plan encoding.
   * Avoids ~2 GPUBuffer allocations per layer per frame in encodeCompositeLayer.
   */
  private acquireCompositeBuffers(): { unif: GPUBuffer; pos: GPUBuffer } {
    const i = this.compositeBufferIndex++
    let pair = this.compositeBufferPool[i]
    if (!pair) {
      pair = {
        unif: this.device.createBuffer({
          size: 64,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        pos: this.device.createBuffer({
          size: 48, // 6 vertices * 2 floats * 4 bytes
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
      }
      this.compositeBufferPool[i] = pair
    }
    return pair
  }

  private encodeSubPlan(
    encoder: GPUCommandEncoder,
    plan: RenderPlanEntry[],
    src: GPUTexture,
    dst: GPUTexture,
    inputFp: string,
  ): { src: GPUTexture; dst: GPUTexture; inputFp: string } {
    for (const entry of plan) {
      if (entry.kind === 'layer') {
        if (!entry.layer.visible || entry.layer.opacity === 0) continue
        this.encodeCompositeLayer(encoder, entry.layer, src, dst, entry.mask)
        ;[src, dst] = [dst, src]
        const l = entry.layer
        const maskPart = entry.mask ? `:M${entry.mask.contentVersion}` : ''
        inputFp += `|L:${l.id}:${l.contentVersion}:${l.opacity}:${l.blendMode}:${l.offsetX}:${l.offsetY}${maskPart}`

      } else if (entry.kind === 'layer-group') {
        if (!entry.visible) continue
        if (entry.blendMode === 'pass-through') {
          // Pass-through: inline children into the parent ping-pong pair.
          const child = this.encodeSubPlan(encoder, entry.children, src, dst, inputFp)
          src = child.src; dst = child.dst; inputFp = child.inputFp
          inputFp += `|GRP-end:${entry.groupId}`
        } else {
          // Isolated: allocate a fresh ping-pong pair for this group.
          const iso1 = this.allocateTempGroupTex()
          const iso2 = this.allocateTempGroupTex()
          this.encodeClearTexture(encoder, iso1)
          this.encodeClearTexture(encoder, iso2)
          const child = this.encodeSubPlan(encoder, entry.children, iso2, iso1, '')
          // Composite the isolated result into the parent context.
          this.encodeCompositeTexture(encoder, child.src, src, dst, entry.opacity, entry.blendMode)
          ;[src, dst] = [dst, src]
          inputFp += `|GRP:${entry.groupId}:${entry.opacity}:${entry.blendMode}:${child.inputFp}`
        }

      } else if (entry.kind === 'adjustment-group') {
        if (!entry.baseLayer.visible || entry.baseLayer.opacity === 0) continue

        let groupResult: GPUTexture

        const paramsKey = computeAdjGroupParamsKey(entry.adjustments)
        const baseMaskVersion = entry.baseMask ? entry.baseMask.contentVersion : -1

        if (this.adjGroupCacheEnabled) {
          const cached = this.adjGroupCache.get(entry.parentLayerId)

          if (
            cached &&
            cached.baseContentVersion === entry.baseLayer.contentVersion &&
            cached.offsetX === entry.baseLayer.offsetX &&
            cached.offsetY === entry.baseLayer.offsetY &&
            cached.baseMaskVersion === baseMaskVersion &&
            cached.paramsKey === paramsKey
          ) {
            // Cache hit: composite the pre-computed result directly.
            groupResult = cached.tex
          } else {
            // Cache miss: run all adjustment passes.
            const result = this.encodeAdjustmentGroup(encoder, entry)

            // Persist the result to a cache texture for subsequent frames.
            const texUsage =
              GPUTextureUsage.TEXTURE_BINDING |
              GPUTextureUsage.COPY_DST |
              GPUTextureUsage.COPY_SRC |
              GPUTextureUsage.RENDER_ATTACHMENT
            const cacheTex = cached?.tex ?? this.device.createTexture({
              size: { width: this.pixelWidth, height: this.pixelHeight },
              format: this.internalFormat,
              usage: texUsage,
            })
            encoder.copyTextureToTexture(
              { texture: result },
              { texture: cacheTex },
              { width: this.pixelWidth, height: this.pixelHeight },
            )
            this.adjGroupCache.set(entry.parentLayerId, {
              baseContentVersion: entry.baseLayer.contentVersion,
              offsetX: entry.baseLayer.offsetX,
              offsetY: entry.baseLayer.offsetY,
              baseMaskVersion,
              paramsKey,
              tex: cacheTex,
            })

            groupResult = result
          }
        } else {
          groupResult = this.encodeAdjustmentGroup(encoder, entry)
        }

        this.encodeCompositeTexture(encoder, groupResult, src, dst, entry.baseLayer.opacity, entry.baseLayer.blendMode)
        ;[src, dst] = [dst, src]
        const l = entry.baseLayer
        inputFp += `|AG:${entry.parentLayerId}:${l.contentVersion}:${l.opacity}:${l.blendMode}:${l.offsetX}:${l.offsetY}:M${baseMaskVersion}:${paramsKey}`

      } else {
        // AdjustmentRenderOp — visible guard already handled per-op in AdjustmentEncoder
        if (!entry.visible) continue
        // In preview mode (e.g. whole-layer drag), skip expensive standalone effects
        // (bloom, halation, glow, drop-shadow, etc.) — they re-run on pointer-up.
        if (this.previewMode) {
          inputFp += `|SKIP:${(entry as AdjustmentRenderOp).layerId}`
          continue
        }
        const op = entry as AdjustmentRenderOp
        const opParamsKey = serializeAdjOp(op)

        if (this.adjGroupCacheEnabled) {
          const cached = this.standaloneOpCache.get(op.layerId)
          if (cached && cached.inputFp === inputFp && cached.paramsKey === opParamsKey) {
            // Cache hit: dst = src + op(src) is replaced by dst = cached. Copy and swap.
            encoder.copyTextureToTexture(
              { texture: cached.tex },
              { texture: dst },
              { width: this.pixelWidth, height: this.pixelHeight },
            )
            ;[src, dst] = [dst, src]
            inputFp += `|SO:${op.layerId}:${opParamsKey}`
            continue
          }
          // Cache miss: encode normally, then snapshot dst into cache.
          this.adjEncoder.encode(encoder, op, src, dst, this.internalFormat)
          ;[src, dst] = [dst, src]
          const texUsage =
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.COPY_SRC |
            GPUTextureUsage.RENDER_ATTACHMENT
          const cacheTex = cached?.tex ?? this.device.createTexture({
            size: { width: this.pixelWidth, height: this.pixelHeight },
            format: this.internalFormat,
            usage: texUsage,
          })
          // After the swap, the op's output now lives in `src`.
          encoder.copyTextureToTexture(
            { texture: src },
            { texture: cacheTex },
            { width: this.pixelWidth, height: this.pixelHeight },
          )
          this.standaloneOpCache.set(op.layerId, { inputFp, paramsKey: opParamsKey, tex: cacheTex })
          inputFp += `|SO:${op.layerId}:${opParamsKey}`
        } else {
          this.adjEncoder.encode(encoder, op, src, dst, this.internalFormat)
          ;[src, dst] = [dst, src]
          inputFp += `|SO:${op.layerId}:${opParamsKey}`
        }
      }
    }
    return { src, dst, inputFp }
  }

  private allocateTempGroupTex(): GPUTexture {
    const texUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT
    const tex = this.createPingPongTex(this.pixelWidth, this.pixelHeight, texUsage)
    this.pendingDestroyTextures.push(tex)
    return tex
  }

  private encodeClearTexture(encoder: GPUCommandEncoder, texture: GPUTexture): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: texture.createView(),
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
      }],
    })
    pass.end()
  }

  private encodeCheckerboard(encoder: GPUCommandEncoder, view: GPUTextureView): void {
    // Uses pre-allocated checkerUniformBuf + checkerBindGroup (static, never change)
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
      }],
    })
    pass.setPipeline(this.checkerPipeline)
    pass.setBindGroup(0, this.checkerBindGroup)
    pass.setVertexBuffer(0, this.canvasQuadVertBuf)
    pass.setVertexBuffer(1, this.texCoordBuffer)
    pass.draw(6)
    pass.end()
  }

  private encodeBlitToView(encoder: GPUCommandEncoder, srcTex: GPUTexture, view: GPUTextureView): void {
    // Uses pre-allocated frameUniformBuf + canvasQuadVertBuf
    const bindGroup = this.device.createBindGroup({
      layout: this.blitBGL,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: this.frameUniformBuf } },
      ],
    })

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        loadOp: 'load',
        storeOp: 'store',
      }],
    })
    pass.setPipeline(this.blitPipeline)
    pass.setBindGroup(0, bindGroup)
    pass.setVertexBuffer(0, this.canvasQuadVertBuf)
    pass.setVertexBuffer(1, this.texCoordBuffer)
    pass.draw(6)
    pass.end()
  }

  private encodeCompositeLayer(
    encoder: GPUCommandEncoder,
    layer: GpuLayer,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    maskLayer?: GpuLayer,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this
    const ox = layer.offsetX
    const oy = layer.offsetY
    const lw = layer.layerWidth
    const lh = layer.layerHeight

    // Step 1: copy src → dst (GPU DMA — no shader, far cheaper than a render pass at 4K)
    encoder.copyTextureToTexture(
      { texture: srcTex },
      { texture: dstTex },
      { width: w, height: h },
    )

    // Step 2: Composite the layer's texture over its sub-rect
    // WGSL CompositeUniforms layout (64 bytes):
    //   offset  0: opacity    : f32
    //   offset  4: blendMode  : u32
    //   offset  8: (pad to align dstRect to 16)
    //   offset 16: dstRect    : vec4f  (4x4 = 16 bytes)
    //   offset 32: hasMask    : u32
    //   offset 36: (pad to align _pad to 16)
    //   offset 48: _pad       : vec3u  (12 bytes)
    //   total size: 64 bytes
    // Acquire a reusable (uniform, vertex) buffer pair from the pool.
    const { unif: unifBuf, pos: posBuffer } = this.acquireCompositeBuffers()
    const unifView = new DataView(new ArrayBuffer(64))
    unifView.setFloat32( 0, layer.opacity, true)
    unifView.setUint32 ( 4, BLEND_MODE_INDEX[layer.blendMode] ?? 0, true)
    unifView.setFloat32(16, ox / w, true)  // dstRect.x
    unifView.setFloat32(20, oy / h, true)  // dstRect.y
    unifView.setFloat32(24, lw / w, true)  // dstRect.z
    unifView.setFloat32(28, lh / h, true)  // dstRect.w
    unifView.setUint32 (32, maskLayer ? 1 : 0, true)
    // _pad at offset 48: left as zero

    writeUniformBuffer(device, unifBuf, unifView.buffer)

    const dummyMaskTex = maskLayer?.texture ?? srcTex // use any fallback if no mask

    const bindGroup = device.createBindGroup({
      layout: this.compositeBGL,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: layer.texture.createView() },
        { binding: 2, resource: srcTex.createView() },
        { binding: 3, resource: dummyMaskTex.createView() },
        { binding: 4, resource: { buffer: unifBuf } },
        { binding: 5, resource: { buffer: this.frameUniformBuf } },
      ],
    })

    // Position quad covering only the layer's canvas-space rect
    device.queue.writeBuffer(posBuffer, 0, new Float32Array([
      ox,      oy,
      ox + lw, oy,
      ox,      oy + lh,
      ox,      oy + lh,
      ox + lw, oy,
      ox + lw, oy + lh,
    ]))

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: dstTex.createView(),
        loadOp: 'load',
        storeOp: 'store',
      }],
    })
    pass.setPipeline(this.compositePipeline)
    pass.setBindGroup(0, bindGroup)
    pass.setVertexBuffer(0, posBuffer)
    pass.setVertexBuffer(1, this.texCoordBuffer)
    pass.draw(6)
    pass.end()
  }

  private encodeCompositeTexture(
    encoder: GPUCommandEncoder,
    texture: GPUTexture,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    opacity: number,
    blendMode: string,
  ): void {
    const pseudoLayer: GpuLayer = {
      id: '__group-composite__',
      name: 'group',
      texture,
      data: new Uint8Array(0),
      format: this.pixelFormat,
      layerWidth:  this.pixelWidth,
      layerHeight: this.pixelHeight,
      offsetX: 0,
      offsetY: 0,
      opacity,
      visible: true,
      blendMode,
      dirtyRect: null,
      contentVersion: 0,
    }
    this.encodeCompositeLayer(encoder, pseudoLayer, srcTex, dstTex)
  }

  private encodeAdjustmentGroup(
    encoder: GPUCommandEncoder,
    entry: Extract<RenderPlanEntry, { kind: 'adjustment-group' }>,
  ): GPUTexture {
    this.encodeClearTexture(encoder, this.groupPingTex)
    this.encodeClearTexture(encoder, this.groupPongTex)

    let srcTex = this.groupPongTex
    let dstTex = this.groupPingTex

    const baseAsSource: GpuLayer = { ...entry.baseLayer, opacity: 1, blendMode: 'normal' }
    this.encodeCompositeLayer(encoder, baseAsSource, srcTex, dstTex, entry.baseMask)
    ;[srcTex, dstTex] = [dstTex, srcTex]

    for (const op of entry.adjustments) {
      if (!op.visible) continue
      this.adjEncoder.encode(encoder, op, srcTex, dstTex, this.internalFormat)
      ;[srcTex, dstTex] = [dstTex, srcTex]
    }

    return srcTex
  }

  private flushPendingDestroys(): void {
    for (const buf of this.pendingDestroyBuffers) buf.destroy()
    this.pendingDestroyBuffers = []
    for (const tex of this.pendingDestroyTextures) tex.destroy()
    this.pendingDestroyTextures = []
    this.adjEncoder.flushPendingDestroys()
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  destroy(): void {
    this.pingTex.destroy()
    this.pongTex.destroy()
    this.groupPingTex.destroy()
    this.groupPongTex.destroy()
    this.texCoordBuffer.destroy()
    this.adjEncoder.destroy()
    for (const entry of this.adjGroupCache.values()) entry.tex.destroy()
    this.adjGroupCache.clear()
    for (const entry of this.standaloneOpCache.values()) entry.tex.destroy()
    this.standaloneOpCache.clear()
    for (const pair of this.compositeBufferPool) {
      pair.unif.destroy()
      pair.pos.destroy()
    }
    this.compositeBufferPool = []
    this.device.destroy()
  }
}
