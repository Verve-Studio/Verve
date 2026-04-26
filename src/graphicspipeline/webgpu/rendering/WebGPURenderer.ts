import {
  createGpuTexture,
  uploadTextureData,
  uploadTexturePatch,
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
  private readonly checkerPipeline: GPURenderPipeline    // renders to screen (canvasFormat)
  private readonly blitPipeline: GPURenderPipeline       // renders to screen (canvasFormat)

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

  // ─── Render cache ──────────────────────────────────────────────────────────
  // Per-adjustment-group output textures: skip re-running adjustment passes when
  // the base layer and params are unchanged since the last frame.
  // Key = parentLayerId. Only used during screen-preview renderPlan() calls, not
  // for flatten / export / readback (which always re-render from scratch).
  private adjGroupCache = new Map<string, {
    baseContentVersion: number
    paramsKey: string
    tex: GPUTexture
  }>()
  // True while encoding a screen-preview renderPlan() — enables the caches above.
  private adjGroupCacheEnabled = false

  readonly pixelWidth: number
  readonly pixelHeight: number
  deferFlush = false

  // ─── Factory ────────────────────────────────────────────────────────────────

  static async create(
    canvas: HTMLCanvasElement,
    pixelWidth: number,
    pixelHeight: number,
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
    return new WebGPURenderer(device, ctx, format, pixelWidth, pixelHeight)
  }

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    canvasFormat: GPUTextureFormat,
    pixelWidth: number,
    pixelHeight: number,
  ) {
    this.device = device
    this.context = context
    this.pixelWidth = pixelWidth
    this.pixelHeight = pixelHeight

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
    this.compositePipeline = this.createCompositePipeline('rgba8unorm')
    this.checkerPipeline   = this.createCheckerPipeline(canvasFormat)
    this.blitPipeline      = this.createBlitPipeline(canvasFormat)
    this.checkerBindGroup  = device.createBindGroup({
      layout: this.checkerPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.checkerUniformBuf } }],
    })

    // Adjustment compute encoder (owns all 25 compute pipelines + texture caches)
    this.adjEncoder = new AdjustmentEncoder(device, pixelWidth, pixelHeight)

    initFilterCompute(this.device, this.pixelWidth, this.pixelHeight)
    initGrabCutCompute(this.device)
  }

  // ─── Pipeline factories ─────────────────────────────────────────────────────

  private createPingPongTex(w: number, h: number, usage: GPUTextureUsageFlags): GPUTexture {
    return this.device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage,
    })
  }

  private createCompositePipeline(format: GPUTextureFormat): GPURenderPipeline {
    const module = this.device.createShaderModule({ code: COMPOSITE_SHADER })
    return this.device.createRenderPipeline({
      layout: 'auto',
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

  private createBlitPipeline(format: GPUTextureFormat): GPURenderPipeline {
    const module = this.device.createShaderModule({ code: BLIT_SHADER })
    return this.device.createRenderPipeline({
      layout: 'auto',
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
  ): GpuLayer {
    const data = new Uint8Array(lw * lh * 4)
    const texture = createGpuTexture(this.device, lw, lh, data)
    return { id, name, texture, data, layerWidth: lw, layerHeight: lh, offsetX: ox, offsetY: oy, opacity: 1, visible: true, blendMode: 'normal', dirtyRect: null, contentVersion: 0 }
  }

  flushLayer(layer: GpuLayer): void {
    if (this.deferFlush) return
    layer.contentVersion++
    if (layer.dirtyRect) {
      const { lx, ly, rx, ry } = layer.dirtyRect
      layer.dirtyRect = null
      uploadTexturePatch(this.device, layer.texture, layer.layerWidth, lx, ly, rx - lx, ry - ly, layer.data)
    } else {
      uploadTextureData(this.device, layer.texture, layer.layerWidth, layer.layerHeight, layer.data)
    }
  }

  destroyLayer(layer: GpuLayer): void {
    layer.texture.destroy()
    const cached = this.adjGroupCache.get(layer.id)
    if (cached) {
      cached.tex.destroy()
      this.adjGroupCache.delete(layer.id)
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
    const newData = new Uint8Array(newW * newH * 4)
    for (let row = 0; row < layer.layerHeight; row++) {
      const srcOff = row * layer.layerWidth * 4
      const dstOff = ((copyY + row) * newW + copyX) * 4
      newData.set(layer.data.subarray(srcOff, srcOff + layer.layerWidth * 4), dstOff)
    }

    // Copy old texture data into new texture using WebGPU
    const newTex = createGpuTexture(this.device, newW, newH, newData)

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

  readLayerPixels(layer: GpuLayer): Uint8Array {
    return layer.data.slice()
  }

  async readFlattenedPixels(layers: GpuLayer[], maskMap?: Map<string, GpuLayer>): Promise<Uint8Array> {
    const plan: RenderPlanEntry[] = layers.map(layer => ({
      kind: 'layer' as const,
      layer,
      mask: maskMap?.get(layer.id),
    }))
    return this.readFlattenedPlan(plan)
  }

  async readFlattenedPlan(plan: RenderPlanEntry[]): Promise<Uint8Array> {
    const { device, pixelWidth: w, pixelHeight: h } = this
    const encoder = device.createCommandEncoder()
    const finalTex = this.encodePlanToComposite(encoder, plan)

    const alignedBpr = Math.ceil(w * 4 / 256) * 256
    const readbuf = createReadbackBuffer(device, alignedBpr * h)
    encoder.copyTextureToBuffer(
      { texture: finalTex },
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
      this.adjEncoder.encode(encoder, op, srcTex, dstTex)
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

  private encodePlanToComposite(
    encoder: GPUCommandEncoder,
    plan: RenderPlanEntry[],
  ): GPUTexture {
    this.encodeClearTexture(encoder, this.pingTex)
    this.encodeClearTexture(encoder, this.pongTex)
    const { src } = this.encodeSubPlan(encoder, plan, this.pongTex, this.pingTex)
    return src
  }

  private encodeSubPlan(
    encoder: GPUCommandEncoder,
    plan: RenderPlanEntry[],
    src: GPUTexture,
    dst: GPUTexture,
  ): { src: GPUTexture; dst: GPUTexture } {
    for (const entry of plan) {
      if (entry.kind === 'layer') {
        if (!entry.layer.visible || entry.layer.opacity === 0) continue
        this.encodeCompositeLayer(encoder, entry.layer, src, dst, entry.mask)
        ;[src, dst] = [dst, src]

      } else if (entry.kind === 'layer-group') {
        if (!entry.visible) continue
        if (entry.blendMode === 'pass-through') {
          // Pass-through: inline children into the parent ping-pong pair.
          ;({ src, dst } = this.encodeSubPlan(encoder, entry.children, src, dst))
        } else {
          // Isolated: allocate a fresh ping-pong pair for this group.
          const iso1 = this.allocateTempGroupTex()
          const iso2 = this.allocateTempGroupTex()
          this.encodeClearTexture(encoder, iso1)
          this.encodeClearTexture(encoder, iso2)
          const { src: isoResult } = this.encodeSubPlan(encoder, entry.children, iso2, iso1)
          // Composite the isolated result into the parent context.
          this.encodeCompositeTexture(encoder, isoResult, src, dst, entry.opacity, entry.blendMode)
          ;[src, dst] = [dst, src]
        }

      } else if (entry.kind === 'adjustment-group') {
        if (!entry.baseLayer.visible || entry.baseLayer.opacity === 0) continue

        let groupResult: GPUTexture

        if (this.adjGroupCacheEnabled) {
          const paramsKey = computeAdjGroupParamsKey(entry.adjustments)
          const cached = this.adjGroupCache.get(entry.parentLayerId)

          if (
            cached &&
            cached.baseContentVersion === entry.baseLayer.contentVersion &&
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
              format: 'rgba8unorm',
              usage: texUsage,
            })
            encoder.copyTextureToTexture(
              { texture: result },
              { texture: cacheTex },
              { width: this.pixelWidth, height: this.pixelHeight },
            )
            this.adjGroupCache.set(entry.parentLayerId, {
              baseContentVersion: entry.baseLayer.contentVersion,
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

      } else {
        // AdjustmentRenderOp — visible guard already handled per-op in AdjustmentEncoder
        if (!entry.visible) continue
        this.adjEncoder.encode(encoder, entry as AdjustmentRenderOp, src, dst)
        ;[src, dst] = [dst, src]
      }
    }
    return { src, dst }
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
      layout: this.blitPipeline.getBindGroupLayout(0),
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
    const unifBuf = createUniformBuffer(device, 64)
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
      layout: this.compositePipeline.getBindGroupLayout(0),
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
    const posBuffer = createVertexBuffer(
      device,
      new Float32Array([
        ox,      oy,
        ox + lw, oy,
        ox,      oy + lh,
        ox,      oy + lh,
        ox + lw, oy,
        ox + lw, oy + lh,
      ])
    )

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

    this.pendingDestroyBuffers.push(unifBuf, posBuffer)
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
      this.adjEncoder.encode(encoder, op, srcTex, dstTex)
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
    this.device.destroy()
  }
}
