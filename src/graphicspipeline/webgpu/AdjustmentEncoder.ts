import {
  createUniformBuffer,
  writeUniformBuffer,
  createStorageBuffer,
  uploadR8TextureData,
} from './utils'
import {
  BC_COMPUTE,
  HS_COMPUTE,
  VIB_COMPUTE,
  CB_COMPUTE,
  BW_COMPUTE,
  TEMP_COMPUTE,
  INVERT_COMPUTE,
  SEL_COLOR_COMPUTE,
  CURVES_COMPUTE,
  CG_COMPUTE,
  RC_COMPUTE,
  DITHER_COMPUTE,
  BLOOM_EXTRACT_COMPUTE,
  BLOOM_DOWNSAMPLE_COMPUTE,
  BLOOM_BLUR_H_COMPUTE,
  BLOOM_BLUR_V_COMPUTE,
  BLOOM_COMPOSITE_COMPUTE,
  CHROMATIC_ABERRATION_COMPUTE,
  HALATION_EXTRACT_COMPUTE,
  CK_COMPUTE,
  DROP_SHADOW_DILATE_H_COMPUTE,
  DROP_SHADOW_DILATE_V_COMPUTE,
  DROP_SHADOW_BLUR_H_COMPUTE,
  DROP_SHADOW_BLUR_V_COMPUTE,
  DROP_SHADOW_COMPOSITE_COMPUTE,
  OUTLINE_DILATE_H_COMPUTE,
  OUTLINE_DILATE_V_COMPUTE,
  OUTLINE_ERODE_H_COMPUTE,
  OUTLINE_ERODE_V_COMPUTE,
  OUTLINE_MASK_COMPUTE,
  OUTLINE_BLUR_H_COMPUTE,
  OUTLINE_BLUR_V_COMPUTE,
  OUTLINE_COMPOSITE_COMPUTE,
  HALFTONE_COMPUTE,
} from './shaders/shaders'
import type {
  GpuLayer,
  AdjustmentRenderOp,
  SelectiveColorPassParams,
  ColorGradingPassParams,
} from './types'
import type { CurvesLuts } from '@/core/operations/adjustments/curves'
import {
  encodeGaussianBlur, encodeBoxBlur, encodeRadialBlur, encodeMotionBlur,
  encodeRemoveMotionBlur, encodeLensBlur, encodeSharpen, encodeSharpenMore,
  encodeUnsharpMask, encodeSmartSharpen, encodeAddNoise, encodeFilmGrain,
  encodeMedian, encodeBilateral, encodeReduceNoise, encodeClouds, encodePixelate,
  bakeRemoveMotionBlur as filterComputeBakeRmb, getRmbPendingBakes, flushFilterComputeDestroys,
} from './compute/filterCompute'

// ─── Free helper ──────────────────────────────────────────────────────────────

function createComputePipeline(device: GPUDevice, wgsl: string, entryPoint: string): GPUComputePipeline {
  const module = device.createShaderModule({ code: wgsl })
  return device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint },
  })
}

// ─── AdjustmentEncoder ────────────────────────────────────────────────────────

/**
 * Owns all adjustment compute pipelines and pass encoders.
 * WebGPURenderer delegates `encodeAdjustmentOp` calls here.
 * Not part of the public API — internal to the renderer module.
 */
export class AdjustmentEncoder {
  private readonly device: GPUDevice
  readonly pixelWidth: number
  readonly pixelHeight: number

  // Simple compute pipelines
  private readonly bcPipeline:       GPUComputePipeline
  private readonly hsPipeline:       GPUComputePipeline
  private readonly vibPipeline:      GPUComputePipeline
  private readonly cbPipeline:       GPUComputePipeline
  private readonly bwPipeline:       GPUComputePipeline
  private readonly tempPipeline:     GPUComputePipeline
  private readonly invertPipeline:   GPUComputePipeline
  private readonly selColorPipeline: GPUComputePipeline
  private readonly curvesPipeline:   GPUComputePipeline
  private readonly cgPipeline:       GPUComputePipeline
  private readonly rcPipeline:       GPUComputePipeline

  // Color Dithering
  private readonly ditherPipeline: GPUComputePipeline

  // Bloom compute pipelines
  private readonly bloomExtractPipeline:    GPUComputePipeline
  private readonly bloomDownsamplePipeline: GPUComputePipeline
  private readonly bloomCompositePipeline:  GPUComputePipeline

  // Shared box-blur pipelines (used by both bloom and halation)
  private readonly boxBlurHPipeline: GPUComputePipeline
  private readonly boxBlurVPipeline: GPUComputePipeline

  // Chromatic aberration
  private readonly caPipeline: GPUComputePipeline

  // Halation
  private readonly halationExtractPipeline: GPUComputePipeline

  // Color key
  private readonly ckPipeline: GPUComputePipeline

  // Drop shadow compute pipelines
  private readonly shadowDilateHPipeline:   GPUComputePipeline
  private readonly shadowDilateVPipeline:   GPUComputePipeline
  private readonly shadowBlurHPipeline:     GPUComputePipeline
  private readonly shadowBlurVPipeline:     GPUComputePipeline
  private readonly shadowCompositePipeline: GPUComputePipeline

  // Outline compute pipelines
  private readonly outlineDilateHPipeline:   GPUComputePipeline
  private readonly outlineDilateVPipeline:   GPUComputePipeline
  private readonly outlineErodeHPipeline:    GPUComputePipeline
  private readonly outlineErodeVPipeline:    GPUComputePipeline
  private readonly outlineMaskPipeline:      GPUComputePipeline
  private readonly outlineBlurHPipeline:     GPUComputePipeline
  private readonly outlineBlurVPipeline:     GPUComputePipeline
  private readonly outlineCompositePipeline: GPUComputePipeline

  // Bloom intermediate texture cache — invalidated when quality changes
  private bloomTexCache: {
    quality:    'full' | 'half' | 'quarter'
    extractTex: GPUTexture
    blurATex:   GPUTexture
    blurBTex:   GPUTexture
  } | null = null

  // Halation texture cache
  private halationTexCache: { glowATex: GPUTexture; glowBTex: GPUTexture } | null = null

  // Drop shadow texture cache
  private shadowTexCache: { tempA: GPUTexture; tempB: GPUTexture } | null = null

  // Outline texture cache
  private outlineTexCache: { tempA: GPUTexture; tempB: GPUTexture; tempC: GPUTexture } | null = null

  // Halftone
  private readonly halftonePipeline: GPUComputePipeline

  // Linear sampler for LUT texture lookups
  private readonly lutSampler: GPUSampler

  // Curves LUT cache
  private readonly curvesLutTextures = new Map<string, { rgb: GPUTexture; red: GPUTexture; green: GPUTexture; blue: GPUTexture }>()
  private readonly curvesLutSignatures = new Map<string, string>()

  // Temporary GPU buffers accumulated during command encoding; flushed after submit.
  private pendingDestroyBuffers: GPUBuffer[] = []

  constructor(device: GPUDevice, pixelWidth: number, pixelHeight: number) {
    this.device      = device
    this.pixelWidth  = pixelWidth
    this.pixelHeight = pixelHeight

    this.bcPipeline       = createComputePipeline(device, BC_COMPUTE,        'cs_brightness_contrast')
    this.hsPipeline       = createComputePipeline(device, HS_COMPUTE,        'cs_hue_saturation')
    this.vibPipeline      = createComputePipeline(device, VIB_COMPUTE,       'cs_color_vibrance')
    this.cbPipeline       = createComputePipeline(device, CB_COMPUTE,        'cs_color_balance')
    this.bwPipeline       = createComputePipeline(device, BW_COMPUTE,        'cs_black_and_white')
    this.tempPipeline     = createComputePipeline(device, TEMP_COMPUTE,      'cs_color_temperature')
    this.invertPipeline   = createComputePipeline(device, INVERT_COMPUTE,    'cs_color_invert')
    this.selColorPipeline = createComputePipeline(device, SEL_COLOR_COMPUTE, 'cs_selective_color')
    this.curvesPipeline   = createComputePipeline(device, CURVES_COMPUTE,    'cs_curves')
    this.cgPipeline       = createComputePipeline(device, CG_COMPUTE,        'cs_color_grading')
    this.rcPipeline       = createComputePipeline(device, RC_COMPUTE,        'cs_reduce_colors')

    this.ditherPipeline   = createComputePipeline(device, DITHER_COMPUTE,    'cs_color_dithering')

    this.bloomExtractPipeline    = createComputePipeline(device, BLOOM_EXTRACT_COMPUTE,    'cs_bloom_extract')
    this.bloomDownsamplePipeline = createComputePipeline(device, BLOOM_DOWNSAMPLE_COMPUTE, 'cs_bloom_downsample')
    this.bloomCompositePipeline  = createComputePipeline(device, BLOOM_COMPOSITE_COMPUTE,  'cs_bloom_composite')

    // Shared box-blur (used by both bloom and halation)
    this.boxBlurHPipeline = createComputePipeline(device, BLOOM_BLUR_H_COMPUTE, 'cs_bloom_blur_h')
    this.boxBlurVPipeline = createComputePipeline(device, BLOOM_BLUR_V_COMPUTE, 'cs_bloom_blur_v')

    this.caPipeline              = createComputePipeline(device, CHROMATIC_ABERRATION_COMPUTE, 'cs_chromatic_aberration')
    this.halationExtractPipeline = createComputePipeline(device, HALATION_EXTRACT_COMPUTE,     'cs_halation_extract')
    this.ckPipeline              = createComputePipeline(device, CK_COMPUTE,                   'cs_color_key')

    this.shadowDilateHPipeline   = createComputePipeline(device, DROP_SHADOW_DILATE_H_COMPUTE,   'cs_shadow_dilate_h')
    this.shadowDilateVPipeline   = createComputePipeline(device, DROP_SHADOW_DILATE_V_COMPUTE,   'cs_shadow_dilate_v')
    this.shadowBlurHPipeline     = createComputePipeline(device, DROP_SHADOW_BLUR_H_COMPUTE,     'cs_shadow_blur_h')
    this.shadowBlurVPipeline     = createComputePipeline(device, DROP_SHADOW_BLUR_V_COMPUTE,     'cs_shadow_blur_v')
    this.shadowCompositePipeline = createComputePipeline(device, DROP_SHADOW_COMPOSITE_COMPUTE,  'cs_shadow_composite')

    this.outlineDilateHPipeline   = createComputePipeline(device, OUTLINE_DILATE_H_COMPUTE,   'cs_outline_dilate_h')
    this.outlineDilateVPipeline   = createComputePipeline(device, OUTLINE_DILATE_V_COMPUTE,   'cs_outline_dilate_v')
    this.outlineErodeHPipeline    = createComputePipeline(device, OUTLINE_ERODE_H_COMPUTE,    'cs_outline_erode_h')
    this.outlineErodeVPipeline    = createComputePipeline(device, OUTLINE_ERODE_V_COMPUTE,    'cs_outline_erode_v')
    this.outlineMaskPipeline      = createComputePipeline(device, OUTLINE_MASK_COMPUTE,       'cs_outline_mask')
    this.outlineBlurHPipeline     = createComputePipeline(device, OUTLINE_BLUR_H_COMPUTE,     'cs_outline_blur_h')
    this.outlineBlurVPipeline     = createComputePipeline(device, OUTLINE_BLUR_V_COMPUTE,     'cs_outline_blur_v')
    this.outlineCompositePipeline = createComputePipeline(device, OUTLINE_COMPOSITE_COMPUTE,  'cs_outline_composite')

    this.halftonePipeline = createComputePipeline(device, HALFTONE_COMPUTE, 'cs_halftone')

    this.lutSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Encode a single adjustment op into the provided command encoder.
   * Replaces the former `WebGPURenderer.encodeAdjustmentOp`.
   */
  encode(
    encoder: GPUCommandEncoder,
    entry: AdjustmentRenderOp,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
  ): void {
    if (entry.kind === 'brightness-contrast') {
      const params = new Float32Array([entry.brightness, entry.contrast, 0, 0])
      this.encodeComputePass(encoder, this.bcPipeline, srcTex, dstTex, params, entry.selMaskLayer)
      return
    }
    if (entry.kind === 'hue-saturation') {
      const params = new Float32Array([entry.hue, entry.saturation, entry.lightness, 0])
      this.encodeComputePass(encoder, this.hsPipeline, srcTex, dstTex, params, entry.selMaskLayer)
      return
    }
    if (entry.kind === 'color-vibrance') {
      const params = new Float32Array([entry.vibrance, entry.saturation, 0, 0])
      this.encodeComputePass(encoder, this.vibPipeline, srcTex, dstTex, params, entry.selMaskLayer)
      return
    }
    if (entry.kind === 'color-balance') {
      const p = entry.params
      const buf = new ArrayBuffer(48)
      const f = new Float32Array(buf)
      const u = new Uint32Array(buf)
      f[0] = p.shadows.cr;    f[1] = p.shadows.mg;    f[2] = p.shadows.yb
      f[3] = p.midtones.cr;   f[4] = p.midtones.mg;   f[5] = p.midtones.yb
      f[6] = p.highlights.cr; f[7] = p.highlights.mg; f[8] = p.highlights.yb
      u[9] = p.preserveLuminosity ? 1 : 0
      this.encodeComputePassRaw(encoder, this.cbPipeline, srcTex, dstTex, buf, entry.selMaskLayer)
      return
    }
    if (entry.kind === 'black-and-white') {
      const p = entry.params
      const params = new Float32Array([p.reds, p.yellows, p.greens, p.cyans, p.blues, p.magentas, 0, 0])
      this.encodeComputePass(encoder, this.bwPipeline, srcTex, dstTex, params, entry.selMaskLayer)
      return
    }
    if (entry.kind === 'color-temperature') {
      const params = new Float32Array([entry.temperature, entry.tint, 0, 0])
      this.encodeComputePass(encoder, this.tempPipeline, srcTex, dstTex, params, entry.selMaskLayer)
      return
    }
    if (entry.kind === 'color-invert') {
      this.encodeInvertPass(encoder, srcTex, dstTex, entry.selMaskLayer)
      return
    }
    if (entry.kind === 'selective-color') {
      this.encodeSelectiveColorPass(encoder, srcTex, dstTex, entry.params, entry.selMaskLayer)
      return
    }
    if (entry.kind === 'curves') {
      this.encodeCurvesPass(encoder, srcTex, dstTex, entry.layerId, entry.luts, entry.selMaskLayer)
      return
    }
    if (entry.kind === 'color-grading') {
      this.encodeColorGradingPass(encoder, srcTex, dstTex, entry.params, entry.selMaskLayer)
      return
    }
    if (entry.kind === 'reduce-colors') {
      this.encodeReduceColorsPass(encoder, srcTex, dstTex, entry.palette, entry.paletteCount, entry.selMaskLayer)
      return
    }
    if (entry.kind === 'color-dithering') {
      this.encodeColorDitheringPass(encoder, srcTex, dstTex, entry.palette, entry.paletteCount, entry.style, entry.opacity, entry.selMaskLayer)
      return
    }
    if (entry.kind === 'bloom') {
      this.encodeBloomPass(
        encoder, srcTex, dstTex,
        entry.threshold, entry.strength, entry.spread, entry.quality,
        entry.selMaskLayer,
      )
      return
    }
    if (entry.kind === 'chromatic-aberration') {
      this.encodeChromaticAberrationPass(encoder, srcTex, dstTex, entry.caType, entry.distance, entry.angle, entry.selMaskLayer)
      return
    }
    if (entry.kind === 'halation') {
      this.encodeHalationPass(encoder, srcTex, dstTex, entry.threshold, entry.spread, entry.blur, entry.strength, entry.selMaskLayer)
      return
    }
    if (entry.kind === 'color-key') {
      const params = new Float32Array([
        entry.keyR, entry.keyG, entry.keyB, entry.tolerance,
        entry.softness, entry.dilation, 0, 0,
      ])
      this.encodeComputePass(encoder, this.ckPipeline, srcTex, dstTex, params, entry.selMaskLayer)
      return
    }
    if (entry.kind === 'drop-shadow') {
      this.encodeDropShadowPass(
        encoder, srcTex, dstTex,
        entry.colorR, entry.colorG, entry.colorB, entry.colorA,
        entry.opacity,
        entry.offsetX, entry.offsetY,
        entry.spread, entry.softness,
        entry.blendMode, entry.knockout,
        entry.selMaskLayer,
      )
      return
    }
    if (entry.kind === 'glow') {
      this.encodeDropShadowPass(
        encoder, srcTex, dstTex,
        entry.colorR, entry.colorG, entry.colorB, entry.colorA,
        entry.opacity,
        0, 0,
        entry.spread, entry.softness,
        entry.blendMode, entry.knockout,
        entry.selMaskLayer,
      )
      return
    }
    if (entry.kind === 'outline') {
      this.encodeOutlinePass(
        encoder, srcTex, dstTex,
        entry.colorR, entry.colorG, entry.colorB, entry.colorA,
        entry.opacity,
        entry.thickness, entry.position, entry.softness,
        entry.selMaskLayer,
      )
      return
    }
    if (entry.kind === 'halftone') {
      const buf = new ArrayBuffer(32)
      const f   = new Float32Array(buf)
      const u   = new Uint32Array(buf)
      f[0] = entry.frequency
      f[1] = entry.offsetC
      f[2] = entry.offsetM
      f[3] = entry.offsetY
      f[4] = entry.offsetK
      u[5] = entry.mode === 'color' ? 0 : 1
      this.encodeComputePassRaw(encoder, this.halftonePipeline, srcTex, dstTex, buf, entry.selMaskLayer)
      return
    }
    const w = this.pixelWidth
    const h = this.pixelHeight
    if (entry.kind === 'gaussian-blur') {
      encodeGaussianBlur(encoder, srcTex, dstTex, w, h, entry.radius)
      return
    }
    if (entry.kind === 'box-blur') {
      encodeBoxBlur(encoder, srcTex, dstTex, w, h, entry.radius)
      return
    }
    if (entry.kind === 'radial-blur') {
      encodeRadialBlur(encoder, srcTex, dstTex, w, h, entry.mode, entry.amount, entry.centerX, entry.centerY, entry.quality)
      return
    }
    if (entry.kind === 'motion-blur') {
      encodeMotionBlur(encoder, srcTex, dstTex, w, h, entry.angle, entry.distance)
      return
    }
    if (entry.kind === 'remove-motion-blur') {
      encodeRemoveMotionBlur(encoder, srcTex, dstTex, w, h, entry.layerId)
      return
    }
    if (entry.kind === 'lens-blur') {
      encodeLensBlur(encoder, srcTex, dstTex, w, h, entry.radius, entry.bladeCount, entry.bladeCurvature, entry.rotation)
      return
    }
    if (entry.kind === 'sharpen') {
      encodeSharpen(encoder, srcTex, dstTex, w, h)
      return
    }
    if (entry.kind === 'sharpen-more') {
      encodeSharpenMore(encoder, srcTex, dstTex, w, h)
      return
    }
    if (entry.kind === 'unsharp-mask') {
      encodeUnsharpMask(encoder, srcTex, dstTex, w, h, entry.amount, entry.radius, entry.threshold)
      return
    }
    if (entry.kind === 'smart-sharpen') {
      encodeSmartSharpen(encoder, srcTex, dstTex, w, h, entry.amount, entry.radius, entry.reduceNoise, entry.remove)
      return
    }
    if (entry.kind === 'add-noise') {
      encodeAddNoise(encoder, srcTex, dstTex, w, h, entry.amount, entry.distribution, entry.monochromatic, entry.seed)
      return
    }
    if (entry.kind === 'film-grain') {
      encodeFilmGrain(encoder, srcTex, dstTex, w, h, entry.grainSize, entry.intensity, entry.roughness, entry.seed)
      return
    }
    if (entry.kind === 'median-filter') {
      encodeMedian(encoder, srcTex, dstTex, w, h, entry.radius)
      return
    }
    if (entry.kind === 'bilateral-filter') {
      encodeBilateral(encoder, srcTex, dstTex, w, h, entry.radius, entry.sigmaSpatial, entry.sigmaColor)
      return
    }
    if (entry.kind === 'reduce-noise') {
      encodeReduceNoise(encoder, srcTex, dstTex, w, h, entry.strength, entry.preserveDetails, entry.reduceColorNoise, entry.sharpenDetails)
      return
    }
    if (entry.kind === 'clouds') {
      encodeClouds(encoder, srcTex, dstTex, w, h, entry.scale, entry.opacity, entry.colorMode, entry.fgColor, entry.bgColor, entry.seed)
      return
    }
    if (entry.kind === 'pixelate') {
      encodePixelate(encoder, srcTex, dstTex, w, h, entry.blockSize)
      return
    }
    const _exhaustive: never = entry
    return _exhaustive
  }

  /** Destroy per-frame GPU buffers accumulated during encode calls. Call after queue.submit(). */
  flushPendingDestroys(): void {
    for (const buf of this.pendingDestroyBuffers) buf.destroy()
    this.pendingDestroyBuffers = []
    flushFilterComputeDestroys()
  }

  /** Returns layer IDs that need async WASM baking for remove-motion-blur. */
  get pendingRemoveMotionBlurBakes(): Set<string> { return getRmbPendingBakes() }

  /** Run async WASM baking for a remove-motion-blur layer. Call when pendingRemoveMotionBlurBakes is non-empty. */
  async bakeRemoveMotionBlur(layerId: string, angle: number, distance: number, noiseReduction: number, srcPixels: Uint8Array): Promise<void> {
    await filterComputeBakeRmb(layerId, srcPixels, this.pixelWidth, this.pixelHeight, angle, distance, noiseReduction)
  }

  /** Destroy all persistent GPU resources (pipelines, texture caches, LUT textures). */
  destroy(): void {
    for (const luts of this.curvesLutTextures.values()) {
      luts.rgb.destroy()
      luts.red.destroy()
      luts.green.destroy()
      luts.blue.destroy()
    }
    this.bloomTexCache?.extractTex.destroy()
    this.bloomTexCache?.blurATex.destroy()
    this.bloomTexCache?.blurBTex.destroy()
    this.bloomTexCache = null
    this.halationTexCache?.glowATex.destroy()
    this.halationTexCache?.glowBTex.destroy()
    this.halationTexCache = null
    this.shadowTexCache?.tempA.destroy()
    this.shadowTexCache?.tempB.destroy()
    this.shadowTexCache = null
    this.outlineTexCache?.tempA.destroy()
    this.outlineTexCache?.tempB.destroy()
    this.outlineTexCache?.tempC.destroy()
    this.outlineTexCache = null
  }

  // ─── Generic compute helpers ─────────────────────────────────────────────────

  private encodeComputePass(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    params: Float32Array,
    selMaskLayer?: GpuLayer,
  ): void {
    this.encodeComputePassRaw(encoder, pipeline, srcTex, dstTex, params.buffer as ArrayBuffer, selMaskLayer)
  }

  private encodeComputePassRaw(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    paramsBuffer: ArrayBuffer,
    selMaskLayer?: GpuLayer,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this

    const alignedSize = Math.max(16, Math.ceil(paramsBuffer.byteLength / 16) * 16)
    const paramsBuf = createUniformBuffer(device, alignedSize)
    device.queue.writeBuffer(paramsBuf, 0, paramsBuffer)

    const maskFlagsData = new Uint32Array(8); maskFlagsData[0] = selMaskLayer ? 1 : 0
    const maskFlagsBuf = createUniformBuffer(device, 32)
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsData)

    const dummyMask = selMaskLayer?.texture ?? srcTex

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: dstTex.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
        { binding: 3, resource: dummyMask.createView() },
        { binding: 4, resource: { buffer: maskFlagsBuf } },
      ],
    })

    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
    pass.end()

    this.pendingDestroyBuffers.push(paramsBuf, maskFlagsBuf)
  }

  // ─── Specialised pass encoders ───────────────────────────────────────────────

  private encodeInvertPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    selMaskLayer?: GpuLayer,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this

    const maskFlagsData = new Uint32Array(8); maskFlagsData[0] = selMaskLayer ? 1 : 0
    const maskFlagsBuf = createUniformBuffer(device, 32)
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsData)

    const dummyMask = selMaskLayer?.texture ?? srcTex

    const bindGroup = device.createBindGroup({
      layout: this.invertPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: dstTex.createView() },
        { binding: 2, resource: dummyMask.createView() },
        { binding: 3, resource: { buffer: maskFlagsBuf } },
      ],
    })

    const pass = encoder.beginComputePass()
    pass.setPipeline(this.invertPipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
    pass.end()

    this.pendingDestroyBuffers.push(maskFlagsBuf)
  }

  private encodeSelectiveColorPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    params: SelectiveColorPassParams,
    selMaskLayer?: GpuLayer,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this

    const RANGE_ORDER = [
      params.reds, params.yellows, params.greens,
      params.cyans, params.blues, params.magentas,
      params.whites, params.neutrals, params.blacks,
    ] as const

    // SelectiveColorParams struct:  4 × array<vec4f,3> + u32 + vec3u = 4×48 + 16 = 208 bytes
    const buf = new ArrayBuffer(208)
    const f = new Float32Array(buf)
    const packArray9 = (offset: number, values: readonly number[]) => {
      for (let i = 0; i < 9; i++) {
        f[offset + i] = values[i]
      }
    }
    packArray9(0,  RANGE_ORDER.map(r => r.cyan))
    packArray9(12, RANGE_ORDER.map(r => r.magenta))
    packArray9(24, RANGE_ORDER.map(r => r.yellow))
    packArray9(36, RANGE_ORDER.map(r => r.black))
    const u32View = new Uint32Array(buf)
    u32View[48] = params.mode === 'relative' ? 1 : 0

    const paramsBuf = createUniformBuffer(device, 208)
    device.queue.writeBuffer(paramsBuf, 0, buf)

    const maskFlagsData = new Uint32Array(8); maskFlagsData[0] = selMaskLayer ? 1 : 0
    const maskFlagsBuf = createUniformBuffer(device, 32)
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsData)

    const dummyMask = selMaskLayer?.texture ?? srcTex

    const bindGroup = device.createBindGroup({
      layout: this.selColorPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: dstTex.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
        { binding: 3, resource: dummyMask.createView() },
        { binding: 4, resource: { buffer: maskFlagsBuf } },
      ],
    })

    const pass = encoder.beginComputePass()
    pass.setPipeline(this.selColorPipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
    pass.end()

    this.pendingDestroyBuffers.push(paramsBuf, maskFlagsBuf)
  }

  private ensureCurvesLutTextures(
    layerId: string,
    luts: CurvesLuts,
  ): { rgb: GPUTexture; red: GPUTexture; green: GPUTexture; blue: GPUTexture } {
    const signature = `${Array.from(luts.rgb).join('.')}-${Array.from(luts.red).join('.')}-${Array.from(luts.green).join('.')}-${Array.from(luts.blue).join('.')}`
    const existing = this.curvesLutTextures.get(layerId)
    const prevSig = this.curvesLutSignatures.get(layerId)
    if (existing && prevSig === signature) return existing

    const writeLut = (data: Uint8Array): GPUTexture => {
      const tex = this.device.createTexture({
        size: { width: 256, height: 1 },
        format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      uploadR8TextureData(this.device, tex, 256, 1, data)
      return tex
    }

    if (existing) {
      existing.rgb.destroy()
      existing.red.destroy()
      existing.green.destroy()
      existing.blue.destroy()
    }

    const next = {
      rgb:   writeLut(luts.rgb),
      red:   writeLut(luts.red),
      green: writeLut(luts.green),
      blue:  writeLut(luts.blue),
    }
    this.curvesLutTextures.set(layerId, next)
    this.curvesLutSignatures.set(layerId, signature)
    return next
  }

  private encodeCurvesPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    layerId: string,
    luts: CurvesLuts,
    selMaskLayer?: GpuLayer,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this
    const textures = this.ensureCurvesLutTextures(layerId, luts)

    const maskFlagsData = new Uint32Array(8); maskFlagsData[0] = selMaskLayer ? 1 : 0
    const maskFlagsBuf = createUniformBuffer(device, 32)
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsData)

    const dummyMask = selMaskLayer?.texture ?? srcTex

    // Note: curvesPipeline has its own bind group layout (no params uniform; uses LUT textures instead)
    const bindGroup = device.createBindGroup({
      layout: this.curvesPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: dstTex.createView() },
        { binding: 2, resource: dummyMask.createView() },
        { binding: 3, resource: { buffer: maskFlagsBuf } },
        { binding: 4, resource: this.lutSampler },
        { binding: 5, resource: textures.rgb.createView() },
        { binding: 6, resource: textures.red.createView() },
        { binding: 7, resource: textures.green.createView() },
        { binding: 8, resource: textures.blue.createView() },
      ],
    })

    const pass = encoder.beginComputePass()
    pass.setPipeline(this.curvesPipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
    pass.end()

    this.pendingDestroyBuffers.push(maskFlagsBuf)
  }

  private encodeColorGradingPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    cgParams: ColorGradingPassParams,
    selMaskLayer?: GpuLayer,
  ): void {
    const { lift, gamma, gain, offset } = cgParams
    const buf = new ArrayBuffer(128)
    const f = new Float32Array(buf)
    f[0]  = lift.r;    f[1]  = lift.g;    f[2]  = lift.b;    f[3]  = lift.master
    f[4]  = gamma.r;   f[5]  = gamma.g;   f[6]  = gamma.b;   f[7]  = gamma.master
    f[8]  = gain.r;    f[9]  = gain.g;    f[10] = gain.b;    f[11] = gain.master
    f[12] = offset.r;  f[13] = offset.g;  f[14] = offset.b;  f[15] = offset.master
    f[16] = cgParams.temp
    f[17] = cgParams.tint
    f[18] = cgParams.contrast
    f[19] = cgParams.pivot
    f[20] = cgParams.midDetail
    f[21] = cgParams.colorBoost
    f[22] = cgParams.shadows
    f[23] = cgParams.highlights
    f[24] = cgParams.saturation
    f[25] = cgParams.hue
    f[26] = cgParams.lumMix
    f[27] = 0 // _pad

    this.encodeComputePassRaw(encoder, this.cgPipeline, srcTex, dstTex, buf, selMaskLayer)
  }

  private encodeReduceColorsPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    palette: Float32Array,
    paletteCount: number,
    selMaskLayer?: GpuLayer,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this

    const paramsData = new Uint32Array(8)
    paramsData[0] = paletteCount
    const paramsBuf = createUniformBuffer(device, 32)
    device.queue.writeBuffer(paramsBuf, 0, paramsData)

    const palBuf = createStorageBuffer(device, 256 * 16)
    device.queue.writeBuffer(palBuf, 0, palette as Float32Array<ArrayBuffer>)

    const maskFlagsData = new Uint32Array(8)
    maskFlagsData[0] = selMaskLayer ? 1 : 0
    const maskFlagsBuf = createUniformBuffer(device, 32)
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsData)

    const dummyMask = selMaskLayer?.texture ?? srcTex

    const bindGroup = device.createBindGroup({
      layout: this.rcPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: dstTex.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
        { binding: 3, resource: dummyMask.createView() },
        { binding: 4, resource: { buffer: maskFlagsBuf } },
        { binding: 5, resource: { buffer: palBuf } },
      ],
    })

    const pass = encoder.beginComputePass()
    pass.setPipeline(this.rcPipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
    pass.end()

    this.pendingDestroyBuffers.push(paramsBuf, palBuf, maskFlagsBuf)
  }

  private encodeColorDitheringPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    palette: Float32Array,
    paletteCount: number,
    style: number,
    opacity: number,
    selMaskLayer?: GpuLayer,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this

    const paramsData = new Uint32Array(8)
    paramsData[0] = paletteCount
    paramsData[1] = style
    paramsData[2] = Math.round(opacity)
    const paramsBuf = createUniformBuffer(device, 32)
    device.queue.writeBuffer(paramsBuf, 0, paramsData)

    const palBuf = createStorageBuffer(device, 256 * 16)
    device.queue.writeBuffer(palBuf, 0, palette as Float32Array<ArrayBuffer>)

    const maskFlagsData = new Uint32Array(8)
    maskFlagsData[0] = selMaskLayer ? 1 : 0
    const maskFlagsBuf = createUniformBuffer(device, 32)
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsData)

    const dummyMask = selMaskLayer?.texture ?? srcTex

    const bindGroup = device.createBindGroup({
      layout: this.ditherPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: dstTex.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
        { binding: 3, resource: dummyMask.createView() },
        { binding: 4, resource: { buffer: maskFlagsBuf } },
        { binding: 5, resource: { buffer: palBuf } },
      ],
    })

    const pass = encoder.beginComputePass()
    pass.setPipeline(this.ditherPipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
    pass.end()

    this.pendingDestroyBuffers.push(paramsBuf, palBuf, maskFlagsBuf)
  }

  private ensureBloomTextures(quality: 'full' | 'half' | 'quarter'): {
    extractTex: GPUTexture
    blurATex:   GPUTexture
    blurBTex:   GPUTexture
  } {
    if (this.bloomTexCache && this.bloomTexCache.quality === quality) {
      return this.bloomTexCache
    }
    this.bloomTexCache?.extractTex.destroy()
    this.bloomTexCache?.blurATex.destroy()
    this.bloomTexCache?.blurBTex.destroy()

    const { device, pixelWidth: w, pixelHeight: h } = this
    const scaleFactor = quality === 'full' ? 1 : quality === 'half' ? 2 : 4
    const bw = Math.ceil(w / scaleFactor)
    const bh = Math.ceil(h / scaleFactor)

    const usage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC

    const make = (tw: number, th: number): GPUTexture =>
      device.createTexture({ size: { width: tw, height: th }, format: 'rgba8unorm', usage })

    this.bloomTexCache = {
      quality,
      extractTex: make(w, h),
      blurATex:   make(bw, bh),
      blurBTex:   make(bw, bh),
    }
    return this.bloomTexCache
  }

  private encodeBloomPass(
    encoder:      GPUCommandEncoder,
    srcTex:       GPUTexture,
    dstTex:       GPUTexture,
    threshold:    number,
    strength:     number,
    spread:       number,
    quality:      'full' | 'half' | 'quarter',
    selMaskLayer: GpuLayer | undefined,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this
    const { extractTex, blurATex, blurBTex } = this.ensureBloomTextures(quality)

    const scaleFactor = quality === 'full' ? 1 : quality === 'half' ? 2 : 4
    const bw          = Math.ceil(w / scaleFactor)
    const bh          = Math.ceil(h / scaleFactor)
    const blurRadius  = Math.max(1, Math.round(spread / scaleFactor))

    const dummyMask    = selMaskLayer?.texture ?? srcTex
    const maskFlagsArr = new Uint32Array(8); maskFlagsArr[0] = selMaskLayer ? 1 : 0
    const maskFlagsBuf = createUniformBuffer(device, 32)
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsArr)

    // ── Pass 1: Extract ──────────────────────────────────────────────────────
    const extractParamsBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, extractParamsBuf, new Float32Array([threshold, 0, 0, 0]))
    const extractBG = device.createBindGroup({
      layout: this.bloomExtractPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: extractTex.createView() },
        { binding: 2, resource: { buffer: extractParamsBuf } },
        { binding: 3, resource: dummyMask.createView() },
        { binding: 4, resource: { buffer: maskFlagsBuf } },
      ],
    })
    const extractPass = encoder.beginComputePass()
    extractPass.setPipeline(this.bloomExtractPipeline)
    extractPass.setBindGroup(0, extractBG)
    extractPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
    extractPass.end()

    // ── Pass 2: Downsample (skipped at Full quality) ─────────────────────────
    let workingSrc = blurATex
    let workingDst = blurBTex

    if (quality !== 'full') {
      const dsParamsBuf = createUniformBuffer(device, 16)
      writeUniformBuffer(device, dsParamsBuf, new Uint32Array([scaleFactor, 0, 0, 0]))
      const dsBG = device.createBindGroup({
        layout: this.bloomDownsamplePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: extractTex.createView() },
          { binding: 1, resource: blurATex.createView() },
          { binding: 2, resource: { buffer: dsParamsBuf } },
        ],
      })
      const dsPass = encoder.beginComputePass()
      dsPass.setPipeline(this.bloomDownsamplePipeline)
      dsPass.setBindGroup(0, dsBG)
      dsPass.dispatchWorkgroups(Math.ceil(bw / 8), Math.ceil(bh / 8))
      dsPass.end()
      this.pendingDestroyBuffers.push(dsParamsBuf)
    } else {
      encoder.copyTextureToTexture(
        { texture: extractTex },
        { texture: blurATex },
        { width: w, height: h },
      )
    }

    // ── Passes 3–8: 3 × H+V box blur ────────────────────────────────────────
    const blurParamsBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, blurParamsBuf, new Uint32Array([blurRadius, 0, 0, 0]))

    for (let i = 0; i < 3; i++) {
      const hBG = device.createBindGroup({
        layout: this.boxBlurHPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: workingSrc.createView() },
          { binding: 1, resource: workingDst.createView() },
          { binding: 2, resource: { buffer: blurParamsBuf } },
        ],
      })
      const hPass = encoder.beginComputePass()
      hPass.setPipeline(this.boxBlurHPipeline)
      hPass.setBindGroup(0, hBG)
      hPass.dispatchWorkgroups(Math.ceil(bw / 8), Math.ceil(bh / 8))
      hPass.end()
      ;[workingSrc, workingDst] = [workingDst, workingSrc]

      const vBG = device.createBindGroup({
        layout: this.boxBlurVPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: workingSrc.createView() },
          { binding: 1, resource: workingDst.createView() },
          { binding: 2, resource: { buffer: blurParamsBuf } },
        ],
      })
      const vPass = encoder.beginComputePass()
      vPass.setPipeline(this.boxBlurVPipeline)
      vPass.setBindGroup(0, vBG)
      vPass.dispatchWorkgroups(Math.ceil(bw / 8), Math.ceil(bh / 8))
      vPass.end()
      ;[workingSrc, workingDst] = [workingDst, workingSrc]
    }

    // ── Pass 9: Composite ────────────────────────────────────────────────────
    const compParamsBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, compParamsBuf, new Float32Array([strength, 0, 0, 0]))
    const compBG = device.createBindGroup({
      layout: this.bloomCompositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: workingSrc.createView() },
        { binding: 2, resource: dstTex.createView() },
        { binding: 3, resource: { buffer: compParamsBuf } },
        { binding: 4, resource: dummyMask.createView() },
        { binding: 5, resource: { buffer: maskFlagsBuf } },
      ],
    })
    const compPass = encoder.beginComputePass()
    compPass.setPipeline(this.bloomCompositePipeline)
    compPass.setBindGroup(0, compBG)
    compPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
    compPass.end()

    this.pendingDestroyBuffers.push(extractParamsBuf, blurParamsBuf, compParamsBuf, maskFlagsBuf)
  }

  private encodeChromaticAberrationPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    caType: 'radial' | 'directional',
    distance: number,
    angle: number,
    selMaskLayer?: GpuLayer,
  ): void {
    const { device } = this
    const w = srcTex.width
    const h = srcTex.height

    const buf = new ArrayBuffer(16)
    const u = new Uint32Array(buf)
    const f = new Float32Array(buf)
    u[0] = caType === 'radial' ? 0 : 1
    f[1] = distance
    f[2] = angle
    // u[3] = 0 (padding)

    const paramsBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, paramsBuf, buf)

    const maskFlagsBuf = createUniformBuffer(device, 32)
    writeUniformBuffer(device, maskFlagsBuf, new Uint32Array([selMaskLayer != null ? 1 : 0, 0, 0, 0, 0, 0, 0, 0]))

    const dummyMask = selMaskLayer?.texture ?? srcTex

    const bg = device.createBindGroup({
      layout: this.caPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: dstTex.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
        { binding: 3, resource: dummyMask.createView() },
        { binding: 4, resource: { buffer: maskFlagsBuf } },
      ],
    })

    const pass = encoder.beginComputePass()
    pass.setPipeline(this.caPipeline)
    pass.setBindGroup(0, bg)
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
    pass.end()

    this.pendingDestroyBuffers.push(paramsBuf, maskFlagsBuf)
  }

  private ensureHalationTextures(): { glowATex: GPUTexture; glowBTex: GPUTexture } {
    if (this.halationTexCache) return this.halationTexCache
    const { device, pixelWidth: w, pixelHeight: h } = this
    const usage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_DST
    const make = (): GPUTexture =>
      device.createTexture({ size: { width: w, height: h }, format: 'rgba8unorm', usage })
    this.halationTexCache = { glowATex: make(), glowBTex: make() }
    return this.halationTexCache
  }

  private encodeHalationPass(
    encoder:      GPUCommandEncoder,
    srcTex:       GPUTexture,
    dstTex:       GPUTexture,
    threshold:    number,
    spread:       number,
    blur:         number,
    strength:     number,
    selMaskLayer: GpuLayer | undefined,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this
    const { glowATex, glowBTex } = this.ensureHalationTextures()

    const dummyMask    = selMaskLayer?.texture ?? srcTex
    const maskFlagsArr = new Uint32Array(8); maskFlagsArr[0] = selMaskLayer ? 1 : 0
    const maskFlagsBuf = createUniformBuffer(device, 32)
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsArr)

    // ── Pass 1: Extract highlights with warm halation tint ───────────────────
    const extractParamsBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, extractParamsBuf, new Float32Array([threshold, 0, 0, 0]))
    const extractBG = device.createBindGroup({
      layout: this.halationExtractPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: glowATex.createView() },
        { binding: 2, resource: { buffer: extractParamsBuf } },
        { binding: 3, resource: dummyMask.createView() },
        { binding: 4, resource: { buffer: maskFlagsBuf } },
      ],
    })
    const extractPass = encoder.beginComputePass()
    extractPass.setPipeline(this.halationExtractPipeline)
    extractPass.setBindGroup(0, extractBG)
    extractPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
    extractPass.end()

    // ── Passes 2–N: blur × H+V iterations (shared box-blur pipelines) ────────
    const blurRadius   = Math.max(1, Math.round(spread))
    const iterations   = Math.max(1, Math.min(5, Math.round(blur)))
    const blurParamsBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, blurParamsBuf, new Uint32Array([blurRadius, 0, 0, 0]))

    let workingSrc = glowATex
    let workingDst = glowBTex

    for (let i = 0; i < iterations; i++) {
      const hBG = device.createBindGroup({
        layout: this.boxBlurHPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: workingSrc.createView() },
          { binding: 1, resource: workingDst.createView() },
          { binding: 2, resource: { buffer: blurParamsBuf } },
        ],
      })
      const hPass = encoder.beginComputePass()
      hPass.setPipeline(this.boxBlurHPipeline)
      hPass.setBindGroup(0, hBG)
      hPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
      hPass.end()
      ;[workingSrc, workingDst] = [workingDst, workingSrc]

      const vBG = device.createBindGroup({
        layout: this.boxBlurVPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: workingSrc.createView() },
          { binding: 1, resource: workingDst.createView() },
          { binding: 2, resource: { buffer: blurParamsBuf } },
        ],
      })
      const vPass = encoder.beginComputePass()
      vPass.setPipeline(this.boxBlurVPipeline)
      vPass.setBindGroup(0, vBG)
      vPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
      vPass.end()
      ;[workingSrc, workingDst] = [workingDst, workingSrc]
    }

    // ── Final pass: composite warm glow onto source (screen blend) ────────────
    const compParamsBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, compParamsBuf, new Float32Array([strength, 0, 0, 0]))
    const compBG = device.createBindGroup({
      layout: this.bloomCompositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: workingSrc.createView() },
        { binding: 2, resource: dstTex.createView() },
        { binding: 3, resource: { buffer: compParamsBuf } },
        { binding: 4, resource: dummyMask.createView() },
        { binding: 5, resource: { buffer: maskFlagsBuf } },
      ],
    })
    const compPass = encoder.beginComputePass()
    compPass.setPipeline(this.bloomCompositePipeline)
    compPass.setBindGroup(0, compBG)
    compPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
    compPass.end()

    this.pendingDestroyBuffers.push(extractParamsBuf, blurParamsBuf, compParamsBuf, maskFlagsBuf)
  }

  private ensureShadowTextures(): { tempA: GPUTexture; tempB: GPUTexture } {
    if (this.shadowTexCache) return this.shadowTexCache
    const { device, pixelWidth: w, pixelHeight: h } = this
    const usage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC
    const make = (): GPUTexture =>
      device.createTexture({ size: { width: w, height: h }, format: 'rgba8unorm', usage })
    this.shadowTexCache = { tempA: make(), tempB: make() }
    return this.shadowTexCache
  }

  private encodeDropShadowPass(
    encoder:      GPUCommandEncoder,
    srcTex:       GPUTexture,
    dstTex:       GPUTexture,
    colorR:       number,
    colorG:       number,
    colorB:       number,
    colorA:       number,
    opacity:      number,
    offsetX:      number,
    offsetY:      number,
    spread:       number,
    softness:     number,
    blendMode:    'normal' | 'multiply' | 'screen',
    knockout:     boolean,
    selMaskLayer: GpuLayer | undefined,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this
    const { tempA, tempB } = this.ensureShadowTextures()

    const spreadR = Math.round(spread)
    const blurR   = softness > 0 ? Math.max(1, Math.round(softness * 0.577)) : 0

    const dilateParamsBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, dilateParamsBuf, new Uint32Array([spreadR, 0, 0, 0]))

    // ── Pass 1: DilateH (srcTex.a → tempA.r) ────────────────────────────────
    const dilateHBG = device.createBindGroup({
      layout: this.shadowDilateHPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: tempA.createView() },
        { binding: 2, resource: { buffer: dilateParamsBuf } },
      ],
    })
    const dilateHPass = encoder.beginComputePass()
    dilateHPass.setPipeline(this.shadowDilateHPipeline)
    dilateHPass.setBindGroup(0, dilateHBG)
    dilateHPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
    dilateHPass.end()

    // ── Pass 2: DilateV (tempA.r → tempB.r) ─────────────────────────────────
    const dilateVBG = device.createBindGroup({
      layout: this.shadowDilateVPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tempA.createView() },
        { binding: 1, resource: tempB.createView() },
        { binding: 2, resource: { buffer: dilateParamsBuf } },
      ],
    })
    const dilateVPass = encoder.beginComputePass()
    dilateVPass.setPipeline(this.shadowDilateVPipeline)
    dilateVPass.setBindGroup(0, dilateVBG)
    dilateVPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
    dilateVPass.end()

    // After dilate passes, mask is in tempB.r
    // ── Passes 3–8: 3× H+V box blur (ping-pong tempB ↔ tempA) ───────────────
    let maskTex: GPUTexture = tempB
    if (softness > 0) {
      const blurParamsBuf = createUniformBuffer(device, 16)
      writeUniformBuffer(device, blurParamsBuf, new Uint32Array([blurR, 0, 0, 0]))

      let workingSrc = tempB
      let workingDst = tempA

      for (let i = 0; i < 3; i++) {
        const hBG = device.createBindGroup({
          layout: this.shadowBlurHPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: workingSrc.createView() },
            { binding: 1, resource: workingDst.createView() },
            { binding: 2, resource: { buffer: blurParamsBuf } },
          ],
        })
        const hPass = encoder.beginComputePass()
        hPass.setPipeline(this.shadowBlurHPipeline)
        hPass.setBindGroup(0, hBG)
        hPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
        hPass.end()
        ;[workingSrc, workingDst] = [workingDst, workingSrc]

        const vBG = device.createBindGroup({
          layout: this.shadowBlurVPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: workingSrc.createView() },
            { binding: 1, resource: workingDst.createView() },
            { binding: 2, resource: { buffer: blurParamsBuf } },
          ],
        })
        const vPass = encoder.beginComputePass()
        vPass.setPipeline(this.shadowBlurVPipeline)
        vPass.setBindGroup(0, vBG)
        vPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
        vPass.end()
        ;[workingSrc, workingDst] = [workingDst, workingSrc]
      }

      // After 3 complete H+V iterations (start: src=tempB, dst=tempA),
      // workingSrc ends up back at tempB.
      maskTex = workingSrc
      this.pendingDestroyBuffers.push(blurParamsBuf)
    }

    // ── Pass 9: Composite (srcTex + maskTex → dstTex) ────────────────────────
    const BLEND_MODE_MAP: Record<'normal' | 'multiply' | 'screen', number> = { normal: 0, multiply: 1, screen: 2 }

    const compBuf = new ArrayBuffer(48)
    const cf = new Float32Array(compBuf)
    const ci = new Int32Array(compBuf)
    const cu = new Uint32Array(compBuf)
    cf[0] = colorR;  cf[1] = colorG;  cf[2] = colorB;  cf[3] = colorA
    cf[4] = opacity
    ci[5] = offsetX; ci[6] = offsetY
    cu[7] = BLEND_MODE_MAP[blendMode]
    cu[8] = knockout ? 1 : 0
    // cu[9..11] = 0 (padding, already zeroed)

    const compParamsBuf = createUniformBuffer(device, 48)
    device.queue.writeBuffer(compParamsBuf, 0, compBuf)

    const maskFlagsArr = new Uint32Array(8); maskFlagsArr[0] = selMaskLayer ? 1 : 0
    const maskFlagsBuf = createUniformBuffer(device, 32)
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsArr)

    const dummyMask = selMaskLayer?.texture ?? srcTex

    const compBG = device.createBindGroup({
      layout: this.shadowCompositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: maskTex.createView() },
        { binding: 2, resource: dstTex.createView() },
        { binding: 3, resource: { buffer: compParamsBuf } },
        { binding: 4, resource: dummyMask.createView() },
        { binding: 5, resource: { buffer: maskFlagsBuf } },
      ],
    })
    const compPass = encoder.beginComputePass()
    compPass.setPipeline(this.shadowCompositePipeline)
    compPass.setBindGroup(0, compBG)
    compPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
    compPass.end()

    this.pendingDestroyBuffers.push(dilateParamsBuf, compParamsBuf, maskFlagsBuf)
  }

  private ensureOutlineTextures(): { tempA: GPUTexture; tempB: GPUTexture; tempC: GPUTexture } {
    if (this.outlineTexCache) return this.outlineTexCache
    const { device, pixelWidth: w, pixelHeight: h } = this
    const usage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC
    const make = (): GPUTexture =>
      device.createTexture({ size: { width: w, height: h }, format: 'rgba8unorm', usage })
    this.outlineTexCache = { tempA: make(), tempB: make(), tempC: make() }
    return this.outlineTexCache
  }

  private encodeOutlinePass(
    encoder:      GPUCommandEncoder,
    srcTex:       GPUTexture,
    dstTex:       GPUTexture,
    colorR:       number,
    colorG:       number,
    colorB:       number,
    colorA:       number,
    opacity:      number,
    thickness:    number,
    position:     'outside' | 'inside' | 'center',
    softness:     number,
    selMaskLayer: GpuLayer | undefined,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this
    const { tempA, tempB, tempC } = this.ensureOutlineTextures()

    const T       = Math.max(1, Math.round(thickness))
    const dilateR = position === 'center' ? Math.ceil(T / 2)  : T
    const erodeR  = position === 'center' ? Math.floor(T / 2) : T
    const blurR   = softness > 0 ? Math.max(1, Math.round(softness * 0.577)) : 0

    const encodeSimpleMorphPass = (
      pipeline: GPUComputePipeline,
      src: GPUTexture, dst: GPUTexture,
      paramsBuf: GPUBuffer,
    ): void => {
      const bg = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: src.createView() },
          { binding: 1, resource: dst.createView() },
          { binding: 2, resource: { buffer: paramsBuf } },
        ],
      })
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bg)
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
      pass.end()
    }

    const dilateParamsBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, dilateParamsBuf, new Uint32Array([dilateR, 0, 0, 0]))

    if (position === 'outside') {
      encodeSimpleMorphPass(this.outlineDilateHPipeline, srcTex, tempA, dilateParamsBuf)
      encodeSimpleMorphPass(this.outlineDilateVPipeline, tempA,  tempB, dilateParamsBuf)
    } else if (position === 'inside') {
      encodeSimpleMorphPass(this.outlineErodeHPipeline, srcTex, tempA, dilateParamsBuf)
      encodeSimpleMorphPass(this.outlineErodeVPipeline, tempA,  tempB, dilateParamsBuf)
    } else {
      const erodeParamsBuf = createUniformBuffer(device, 16)
      writeUniformBuffer(device, erodeParamsBuf, new Uint32Array([erodeR, 0, 0, 0]))
      encodeSimpleMorphPass(this.outlineDilateHPipeline, srcTex, tempA, dilateParamsBuf)
      encodeSimpleMorphPass(this.outlineDilateVPipeline, tempA,  tempC, dilateParamsBuf)
      encodeSimpleMorphPass(this.outlineErodeHPipeline,  srcTex, tempA, erodeParamsBuf)
      encodeSimpleMorphPass(this.outlineErodeVPipeline,  tempA,  tempB, erodeParamsBuf)
      this.pendingDestroyBuffers.push(erodeParamsBuf)
    }

    // Mask derivation pass — output goes into tempA
    const MODE_MAP = { outside: 0, inside: 1, center: 2 } as const
    const maskParamsBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, maskParamsBuf, new Uint32Array([MODE_MAP[position], 0, 0, 0]))

    const morphATex = position === 'center' ? tempC : (position === 'outside' ? tempB : srcTex)
    const morphBTex = position === 'center' ? tempB : (position === 'inside'  ? tempB : srcTex)

    const maskBG = device.createBindGroup({
      layout: this.outlineMaskPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView()    },
        { binding: 1, resource: morphATex.createView() },
        { binding: 2, resource: morphBTex.createView() },
        { binding: 3, resource: tempA.createView()     },
        { binding: 4, resource: { buffer: maskParamsBuf } },
      ],
    })
    const maskPass = encoder.beginComputePass()
    maskPass.setPipeline(this.outlineMaskPipeline)
    maskPass.setBindGroup(0, maskBG)
    maskPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
    maskPass.end()

    // Softness blur: 3× H+V box blur (ping-pong tempA ↔ tempB)
    let strokeMaskTex: GPUTexture = tempA
    if (softness > 0) {
      const blurParamsBuf = createUniformBuffer(device, 16)
      writeUniformBuffer(device, blurParamsBuf, new Uint32Array([blurR, 0, 0, 0]))

      let workingSrc = tempA
      let workingDst = tempB

      for (let i = 0; i < 3; i++) {
        encodeSimpleMorphPass(this.outlineBlurHPipeline, workingSrc, workingDst, blurParamsBuf)
        ;[workingSrc, workingDst] = [workingDst, workingSrc]
        encodeSimpleMorphPass(this.outlineBlurVPipeline, workingSrc, workingDst, blurParamsBuf)
        ;[workingSrc, workingDst] = [workingDst, workingSrc]
      }

      strokeMaskTex = workingSrc
      this.pendingDestroyBuffers.push(blurParamsBuf)
    }

    // Composite pass
    const compBuf = new ArrayBuffer(32)
    const cf = new Float32Array(compBuf)
    cf[0] = colorR; cf[1] = colorG; cf[2] = colorB; cf[3] = colorA
    cf[4] = opacity
    // cf[5..7] = 0 (padding, already zeroed)
    const compParamsBuf = createUniformBuffer(device, 32)
    device.queue.writeBuffer(compParamsBuf, 0, compBuf)

    const maskFlagsArr = new Uint32Array(8); maskFlagsArr[0] = selMaskLayer ? 1 : 0
    const maskFlagsBuf = createUniformBuffer(device, 32)
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsArr)

    const dummyMask = selMaskLayer?.texture ?? srcTex

    const compBG = device.createBindGroup({
      layout: this.outlineCompositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView()         },
        { binding: 1, resource: strokeMaskTex.createView()  },
        { binding: 2, resource: dstTex.createView()         },
        { binding: 3, resource: { buffer: compParamsBuf }   },
        { binding: 4, resource: dummyMask.createView()      },
        { binding: 5, resource: { buffer: maskFlagsBuf }    },
      ],
    })
    const compPass = encoder.beginComputePass()
    compPass.setPipeline(this.outlineCompositePipeline)
    compPass.setBindGroup(0, compBG)
    compPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
    compPass.end()

    this.pendingDestroyBuffers.push(dilateParamsBuf, maskParamsBuf, compParamsBuf, maskFlagsBuf)
  }
}
