import { FILTER_GAUSSIAN_H_COMPUTE, FILTER_GAUSSIAN_V_COMPUTE, runGaussianBlur } from '../shaders/compute/filters/gaussian-blur'
import { FILTER_BOX_H_COMPUTE, FILTER_BOX_V_COMPUTE, runBoxBlur } from '../shaders/compute/filters/box-blur'
import { FILTER_RADIAL_BLUR_COMPUTE, runRadialBlur } from '../shaders/compute/filters/radial-blur'
import { FILTER_MOTION_BLUR_COMPUTE, runMotionBlur } from '../shaders/compute/filters/motion-blur'
import { FILTER_LENS_BLUR_COMPUTE, buildKernelEntries, runLensBlur } from '../shaders/compute/filters/lens-blur'
import { FILTER_SHARPEN_COMPUTE, FILTER_SHARPEN_MORE_COMPUTE, FILTER_UNSHARP_COMBINE_COMPUTE, runSharpen, runSharpenMore, runUnsharpMask } from '../shaders/compute/filters/sharpen'
import { FILTER_SMART_SHARPEN_GAUSS_COMBINE_COMPUTE, FILTER_SMART_SHARPEN_LENS_COMPUTE, FILTER_SMART_SHARPEN_BLEND_COMPUTE, runSmartSharpen } from '../shaders/compute/filters/smart-sharpen'
import { FILTER_ADD_NOISE_COMPUTE, runAddNoise } from '../shaders/compute/filters/add-noise'
import { FILTER_FILM_GRAIN_NOISE_COMPUTE, FILTER_FILM_GRAIN_COMBINE_COMPUTE, runFilmGrain } from '../shaders/compute/filters/film-grain'
import { FILTER_CLOUDS_COMPUTE, runClouds } from '../shaders/compute/filters/clouds'
import { FILTER_MEDIAN_COMPUTE, runMedian } from '../shaders/compute/filters/median'
import { FILTER_BILATERAL_COMPUTE, runBilateral } from '../shaders/compute/filters/bilateral'
import { FILTER_REDUCE_NOISE_COMPUTE, runReduceNoise } from '../shaders/compute/filters/reduce-noise'
import { FILTER_LENS_FLARE_COMPUTE, runRenderLensFlare } from '../shaders/compute/filters/lens-flare'
import { FILTER_PIXELATE_COMPUTE, runPixelate } from '../shaders/compute/filters/pixelate'
import { createUniformBuffer, writeUniformBuffer } from '../utils'
import { FILTER_RMB_PSF_COMPUTE, FILTER_RMB_RATIO_COMPUTE, FILTER_RMB_UPDATE_COMPUTE, FILTER_RMB_FINAL_COMPUTE } from '../shaders/compute/filters/remove-motion-blur'

// ─── Pipeline pair type ───────────────────────────────────────────────────────

type FilterPipelinePair = { s8: GPURenderPipeline; f32: GPURenderPipeline }

function createFilterRenderPipelinePair(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  fragmentEntryPoint: string,
): FilterPipelinePair {
  const makePipeline = (format: GPUTextureFormat): GPURenderPipeline =>
    device.createRenderPipeline({
      layout: 'auto',
      vertex:    { module: shaderModule, entryPoint: 'vs_adj' },
      fragment:  { module: shaderModule, entryPoint: fragmentEntryPoint, targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    })
  return { s8: makePipeline('rgba8unorm'), f32: makePipeline('rgba32float') }
}

function createFilterRenderPipeline(
  device: GPUDevice,
  wgsl: string,
  fragmentEntryPoint: string,
  format: GPUTextureFormat,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: wgsl })
  return device.createRenderPipeline({
    layout: 'auto',
    vertex:    { module, entryPoint: 'vs_adj' },
    fragment:  { module, entryPoint: fragmentEntryPoint, targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  })
}

// ─── Engine ───────────────────────────────────────────────────────────────────

class FilterComputeEngine {
  private readonly device: GPUDevice
  private readonly format: GPUTextureFormat
  private readonly sampler: GPUSampler
  private readonly gaussianHPipeline: FilterPipelinePair
  private readonly gaussianVPipeline: FilterPipelinePair
  private readonly boxHPipeline: FilterPipelinePair
  private readonly boxVPipeline: FilterPipelinePair
  private readonly radialBlurPipeline: FilterPipelinePair
  private readonly motionBlurPipeline: FilterPipelinePair
  private readonly lensBlurPipeline: FilterPipelinePair
  private readonly sharpenPipeline: FilterPipelinePair
  private readonly sharpenMorePipeline: FilterPipelinePair
  private readonly unsharpCombinePipeline: FilterPipelinePair
  private readonly smartSharpenGaussCombinePipeline: FilterPipelinePair
  private readonly smartSharpenLensPipeline: FilterPipelinePair
  private readonly smartSharpenBlendPipeline: FilterPipelinePair
  private readonly addNoisePipeline: FilterPipelinePair
  private readonly filmGrainNoisePipeline: GPURenderPipeline
  private readonly filmGrainCombinePipeline: FilterPipelinePair
  private readonly cloudsPipeline: FilterPipelinePair
  private readonly medianPipeline: FilterPipelinePair
  private readonly bilateralPipeline: FilterPipelinePair
  private readonly reduceNoisePipeline: FilterPipelinePair
  private readonly lensFlareRenderPipeline: GPURenderPipeline
  private readonly pixelatePipeline: FilterPipelinePair
  private readonly rmbPsfPipeline: GPURenderPipeline
  private readonly rmbRatioPipeline: GPURenderPipeline
  private readonly rmbUpdatePipeline: GPURenderPipeline
  private readonly rmbFinalPipeline: FilterPipelinePair
  private readonly intermediate0: GPUTexture
  private cachedKernelKey: string = ''
  private cachedKernelBuf: GPUBuffer | null = null
  private cachedKernelCount: number = 0
  pendingDestroyBuffers: GPUBuffer[] = []
  pendingDestroyTextures: GPUTexture[] = []

  private constructor(device: GPUDevice, width: number, height: number, format: GPUTextureFormat) {
    this.device = device
    this.format = format
    this.sampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    this.intermediate0 = device.createTexture({
      size: { width, height },
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.gaussianHPipeline               = this.makePair(FILTER_GAUSSIAN_H_COMPUTE, 'fs_gaussian_h')
    this.gaussianVPipeline               = this.makePair(FILTER_GAUSSIAN_V_COMPUTE, 'fs_gaussian_v')
    this.boxHPipeline                    = this.makePair(FILTER_BOX_H_COMPUTE, 'fs_box_h')
    this.boxVPipeline                    = this.makePair(FILTER_BOX_V_COMPUTE, 'fs_box_v')
    this.radialBlurPipeline              = this.makePair(FILTER_RADIAL_BLUR_COMPUTE, 'fs_radial_blur')
    this.motionBlurPipeline              = this.makePair(FILTER_MOTION_BLUR_COMPUTE, 'fs_motion_blur')
    this.lensBlurPipeline                = this.makePair(FILTER_LENS_BLUR_COMPUTE, 'fs_lens_blur')
    this.sharpenPipeline                 = this.makePair(FILTER_SHARPEN_COMPUTE, 'fs_sharpen')
    this.sharpenMorePipeline             = this.makePair(FILTER_SHARPEN_MORE_COMPUTE, 'fs_sharpen_more')
    this.unsharpCombinePipeline          = this.makePair(FILTER_UNSHARP_COMBINE_COMPUTE, 'fs_unsharp_combine')
    this.smartSharpenGaussCombinePipeline = this.makePair(FILTER_SMART_SHARPEN_GAUSS_COMBINE_COMPUTE, 'fs_smart_sharpen_gauss')
    this.smartSharpenLensPipeline        = this.makePair(FILTER_SMART_SHARPEN_LENS_COMPUTE, 'fs_smart_sharpen_lens')
    this.smartSharpenBlendPipeline       = this.makePair(FILTER_SMART_SHARPEN_BLEND_COMPUTE, 'fs_smart_sharpen_blend')
    this.addNoisePipeline                = this.makePair(FILTER_ADD_NOISE_COMPUTE, 'fs_add_noise')
    this.filmGrainNoisePipeline          = createFilterRenderPipeline(device, FILTER_FILM_GRAIN_NOISE_COMPUTE, 'fs_film_grain_noise', 'rgba8unorm')
    this.filmGrainCombinePipeline        = this.makePair(FILTER_FILM_GRAIN_COMBINE_COMPUTE, 'fs_film_grain_combine')
    this.cloudsPipeline                  = this.makePair(FILTER_CLOUDS_COMPUTE, 'fs_clouds')
    this.medianPipeline                  = this.makePair(FILTER_MEDIAN_COMPUTE, 'fs_median')
    this.bilateralPipeline               = this.makePair(FILTER_BILATERAL_COMPUTE, 'fs_bilateral')
    this.reduceNoisePipeline             = this.makePair(FILTER_REDUCE_NOISE_COMPUTE, 'fs_reduce_noise')
    this.lensFlareRenderPipeline         = createFilterRenderPipeline(device, FILTER_LENS_FLARE_COMPUTE, 'fs_lens_flare', 'rgba8unorm')
    this.pixelatePipeline                = this.makePair(FILTER_PIXELATE_COMPUTE, 'fs_pixelate')
    this.rmbPsfPipeline                  = createFilterRenderPipeline(device, FILTER_RMB_PSF_COMPUTE, 'fs_rmb_psf', 'rgba16float')
    this.rmbRatioPipeline                = createFilterRenderPipeline(device, FILTER_RMB_RATIO_COMPUTE, 'fs_rmb_ratio', 'rgba16float')
    this.rmbUpdatePipeline               = createFilterRenderPipeline(device, FILTER_RMB_UPDATE_COMPUTE, 'fs_rmb_update', 'rgba16float')
    this.rmbFinalPipeline                = this.makePair(FILTER_RMB_FINAL_COMPUTE, 'fs_rmb_final')
  }

  static create(device: GPUDevice, width: number, height: number, format: GPUTextureFormat = 'rgba8unorm'): FilterComputeEngine {
    return new FilterComputeEngine(device, width, height, format)
  }

  destroy(): void {
    this.intermediate0.destroy()
    this.cachedKernelBuf?.destroy()
    this.cachedKernelBuf = null
  }

  private makePair(wgsl: string, entryPoint: string): FilterPipelinePair {
    const module = this.device.createShaderModule({ code: wgsl })
    return createFilterRenderPipelinePair(this.device, module, entryPoint)
  }

  private selectPipeline(pair: FilterPipelinePair, dstTex: GPUTexture): GPURenderPipeline {
    return dstTex.format === 'rgba32float' ? pair.f32 : pair.s8
  }

  async gaussianBlur(pixels: Uint8Array, width: number, height: number, radius: number): Promise<Uint8Array> {
    return runGaussianBlur(this.device, this.gaussianHPipeline.s8, this.gaussianVPipeline.s8, pixels, width, height, radius)
  }

  async boxBlur(pixels: Uint8Array, width: number, height: number, radius: number): Promise<Uint8Array> {
    return runBoxBlur(this.device, this.boxHPipeline.s8, this.boxVPipeline.s8, pixels, width, height, radius)
  }

  async radialBlur(pixels: Uint8Array, width: number, height: number, mode: number, amount: number, centerX: number, centerY: number, quality: number): Promise<Uint8Array> {
    return runRadialBlur(this.device, this.radialBlurPipeline.s8, pixels, width, height, mode, amount, centerX, centerY, quality)
  }

  async motionBlur(pixels: Uint8Array, width: number, height: number, angleDeg: number, distance: number): Promise<Uint8Array> {
    return runMotionBlur(this.device, this.motionBlurPipeline.s8, pixels, width, height, angleDeg, distance)
  }

  async lensBlur(pixels: Uint8Array, width: number, height: number, radius: number, bladeCount: number, bladeCurvature: number, rotation: number): Promise<Uint8Array> {
    const key = `${radius}|${bladeCount}|${bladeCurvature}|${rotation}`
    if (this.cachedKernelKey !== key) {
      this.cachedKernelBuf?.destroy()
      const entries = buildKernelEntries(radius, bladeCount, bladeCurvature, rotation)
      const buf = this.device.createBuffer({ size: Math.max(entries.byteLength, 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
      this.device.queue.writeBuffer(buf, 0, entries.buffer as ArrayBuffer, 0, entries.byteLength)
      this.cachedKernelBuf = buf
      this.cachedKernelKey = key
      this.cachedKernelCount = entries.length / 4
    }
    return runLensBlur(this.device, this.lensBlurPipeline.s8, pixels, width, height, this.cachedKernelBuf!, this.cachedKernelCount)
  }

  async sharpen(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
    return runSharpen(this.device, this.sharpenPipeline.s8, pixels, width, height)
  }

  async sharpenMore(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
    return runSharpenMore(this.device, this.sharpenMorePipeline.s8, pixels, width, height)
  }

  async unsharpMask(pixels: Uint8Array, width: number, height: number, amount: number, radius: number, threshold: number): Promise<Uint8Array> {
    return runUnsharpMask(this.device, this.gaussianHPipeline.s8, this.gaussianVPipeline.s8, this.unsharpCombinePipeline.s8, pixels, width, height, amount, radius, threshold)
  }

  async smartSharpen(pixels: Uint8Array, width: number, height: number, amount: number, radius: number, reduceNoise: number, remove: number): Promise<Uint8Array> {
    return runSmartSharpen(this.device, this.gaussianHPipeline.s8, this.gaussianVPipeline.s8, this.boxHPipeline.s8, this.boxVPipeline.s8, this.smartSharpenGaussCombinePipeline.s8, this.smartSharpenLensPipeline.s8, this.smartSharpenBlendPipeline.s8, pixels, width, height, amount, radius, reduceNoise, remove)
  }

  async addNoise(pixels: Uint8Array, width: number, height: number, amount: number, distribution: number, monochromatic: number, seed: number): Promise<Uint8Array> {
    return runAddNoise(this.device, this.addNoisePipeline.s8, pixels, width, height, amount, distribution, monochromatic, seed)
  }

  async filmGrain(pixels: Uint8Array, width: number, height: number, grainSize: number, intensity: number, roughness: number, seed: number): Promise<Uint8Array> {
    return runFilmGrain(this.device, this.filmGrainNoisePipeline, this.filmGrainCombinePipeline.s8, this.boxHPipeline.s8, this.boxVPipeline.s8, pixels, width, height, grainSize, intensity, roughness, seed)
  }

  async clouds(pixels: Uint8Array, width: number, height: number, scale: number, opacity: number, colorMode: number, fgR: number, fgG: number, fgB: number, bgR: number, bgG: number, bgB: number, seed: number): Promise<Uint8Array> {
    return runClouds(this.device, this.cloudsPipeline.s8, pixels, width, height, scale, opacity, colorMode, fgR, fgG, fgB, bgR, bgG, bgB, seed)
  }

  async median(pixels: Uint8Array, width: number, height: number, radius: number): Promise<Uint8Array> {
    return runMedian(this.device, this.medianPipeline.s8, pixels, width, height, radius)
  }

  async bilateral(pixels: Uint8Array, width: number, height: number, radius: number, sigmaSpatial: number, sigmaColor: number): Promise<Uint8Array> {
    return runBilateral(this.device, this.bilateralPipeline.s8, pixels, width, height, radius, sigmaSpatial, sigmaColor)
  }

  async reduceNoise(pixels: Uint8Array, width: number, height: number, strength: number, preserveDetails: number, reduceColorNoise: number, sharpenDetails: number): Promise<Uint8Array> {
    return runReduceNoise(this.device, this.reduceNoisePipeline.s8, pixels, width, height, strength, preserveDetails, reduceColorNoise, sharpenDetails, (p, w, h, a, r, t) => this.unsharpMask(p, w, h, a, r, t))
  }

  async renderLensFlare(width: number, height: number, centerX: number, centerY: number, brightness: number, lensType: number, ringOpacity: number, streakStrength: number, streakWidth: number, streakRotation: number): Promise<Uint8Array> {
    return runRenderLensFlare(this.device, this.lensFlareRenderPipeline, width, height, centerX, centerY, brightness, lensType, ringOpacity, streakStrength, streakWidth, streakRotation)
  }

  async pixelate(pixels: Uint8Array, width: number, height: number, blockSize: number): Promise<Uint8Array> {
    return runPixelate(this.device, this.pixelatePipeline.s8, pixels, width, height, blockSize)
  }

  // ─── Encode methods (synchronous, record into an existing GPUCommandEncoder) ──

  flushPendingDestroys(): void {
    for (const buf of this.pendingDestroyBuffers) buf.destroy()
    this.pendingDestroyBuffers = []
    for (const tex of this.pendingDestroyTextures) tex.destroy()
    this.pendingDestroyTextures = []
  }

  private makeRgba16FloatTex(w: number, h: number): GPUTexture {
    const tex = this.device.createTexture({
      size: { width: w, height: h },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.pendingDestroyTextures.push(tex)
    return tex
  }

  private makeRgba8Tex(w: number, h: number): GPUTexture {
    const tex = this.device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.pendingDestroyTextures.push(tex)
    return tex
  }

  private makeParamsBuf(data: Uint32Array | Float32Array | ArrayBuffer): GPUBuffer {
    const byteLen = data instanceof ArrayBuffer ? data.byteLength : (data as Uint32Array).byteLength
    const buf = createUniformBuffer(this.device, Math.max(byteLen, 16))
    writeUniformBuffer(this.device, buf, data instanceof ArrayBuffer ? data : data as Uint32Array)
    this.pendingDestroyBuffers.push(buf)
    return buf
  }

  private encodeRenderPass(encoder: GPUCommandEncoder, pipeline: GPURenderPipeline, entries: GPUBindGroupEntry[], dstTex: GPUTexture): void {
    const bg   = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries })
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: dstTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bg)
    pass.draw(6)
    pass.end()
  }

  encodeGaussianBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, radius: number): void {
    const paramsBuf = this.makeParamsBuf(new Uint32Array([radius, 0, 0, 0]))
    this.encodeRenderPass(encoder, this.selectPipeline(this.gaussianHPipeline, this.intermediate0), [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], this.intermediate0)
    this.encodeRenderPass(encoder, this.selectPipeline(this.gaussianVPipeline, dstTex), [
      { binding: 0, resource: this.intermediate0.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], dstTex)
  }

  encodeBoxBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, radius: number): void {
    const paramsBuf = this.makeParamsBuf(new Uint32Array([radius, 0, 0, 0]))
    this.encodeRenderPass(encoder, this.selectPipeline(this.boxHPipeline, this.intermediate0), [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], this.intermediate0)
    this.encodeRenderPass(encoder, this.selectPipeline(this.boxVPipeline, dstTex), [
      { binding: 0, resource: this.intermediate0.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], dstTex)
  }

  encodeRadialBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, mode: number, amount: number, centerX: number, centerY: number, quality: number): void {
    const buf = new ArrayBuffer(32)
    const dv = new DataView(buf)
    dv.setUint32(0, mode, true); dv.setUint32(4, amount, true); dv.setUint32(8, quality, true); dv.setUint32(12, 0, true)
    dv.setFloat32(16, centerX, true); dv.setFloat32(20, centerY, true); dv.setFloat32(24, 0, true); dv.setFloat32(28, 0, true)
    const paramsBuf = this.makeParamsBuf(buf)
    this.encodeRenderPass(encoder, this.selectPipeline(this.radialBlurPipeline, dstTex), [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], dstTex)
  }

  encodeMotionBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, angle: number, distance: number): void {
    const buf = new ArrayBuffer(16)
    const dv = new DataView(buf)
    dv.setFloat32(0, angle, true); dv.setUint32(4, distance, true); dv.setUint32(8, 0, true); dv.setUint32(12, 0, true)
    const paramsBuf = this.makeParamsBuf(buf)
    this.encodeRenderPass(encoder, this.selectPipeline(this.motionBlurPipeline, dstTex), [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], dstTex)
  }

  encodeRemoveMotionBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, angle: number, distance: number, noiseReduction: number): void {
    // 8–15 iterations: noiseReduction=0 → 15, noiseReduction=100 → 8
    const iterations = 8 + Math.round((100 - noiseReduction) / 14)
    const blendBack  = (noiseReduction / 100) * 0.35

    // PSF params reused for all forward and back-projection passes.
    const buf = new ArrayBuffer(16)
    const dv  = new DataView(buf)
    dv.setFloat32(0, angle, true); dv.setUint32(4, distance, true)
    dv.setUint32(8, 0, true); dv.setUint32(12, 0, true)
    const psfParamsBuf = this.makeParamsBuf(buf)

    // Final blend params.
    const finalBuf = new ArrayBuffer(16)
    const fdv = new DataView(finalBuf)
    fdv.setFloat32(0, blendBack, true)
    const finalParamsBuf = this.makeParamsBuf(finalBuf)

    // Intermediate rgba16float textures for RL ping-pong.
    const estA  = this.makeRgba16FloatTex(w, h) // even-iteration estimate output
    const estB  = this.makeRgba16FloatTex(w, h) // odd-iteration estimate output
    const temp  = this.makeRgba16FloatTex(w, h) // PSF scratch (reused for fwd + back)
    const ratio = this.makeRgba16FloatTex(w, h) // ratio = input / PSF(est)

    // For iteration 0 the estimate starts as srcTex. Subsequent iterations use estA / estB.
    let curEst: GPUTexture = srcTex

    for (let i = 0; i < iterations; i++) {
      const nextEst = (i % 2 === 0) ? estA : estB

      // Step 1 — Forward PSF: PSF(curEst) → temp
      this.encodeRenderPass(encoder, this.rmbPsfPipeline, [
        { binding: 0, resource: curEst.createView() },
        { binding: 1, resource: { buffer: psfParamsBuf } },
      ], temp)

      // Step 2 — Ratio: input / PSF(est) → ratio
      this.encodeRenderPass(encoder, this.rmbRatioPipeline, [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: temp.createView() },
      ], ratio)

      // Step 3 — Back-projection: PSF(ratio) → temp  (reuse temp; ratio is done)
      this.encodeRenderPass(encoder, this.rmbPsfPipeline, [
        { binding: 0, resource: ratio.createView() },
        { binding: 1, resource: { buffer: psfParamsBuf } },
      ], temp)

      // Step 4 — RL Update: est * PSF(ratio) → nextEst
      this.encodeRenderPass(encoder, this.rmbUpdatePipeline, [
        { binding: 0, resource: curEst.createView() },
        { binding: 1, resource: temp.createView() },
      ], nextEst)

      curEst = nextEst
    }

    // Final pass — blend deblurred estimate with original → dstTex
    this.encodeRenderPass(encoder, this.selectPipeline(this.rmbFinalPipeline, dstTex), [
      { binding: 0, resource: curEst.createView() },
      { binding: 1, resource: srcTex.createView() },
      { binding: 2, resource: { buffer: finalParamsBuf } },
    ], dstTex)
  }

  encodeLensBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, radius: number, bladeCount: number, bladeCurvature: number, rotation: number): void {
    const key = `${radius}|${bladeCount}|${bladeCurvature}|${rotation}`
    if (this.cachedKernelKey !== key) {
      this.cachedKernelBuf?.destroy()
      const entries = buildKernelEntries(radius, bladeCount, bladeCurvature, rotation)
      const buf = this.device.createBuffer({ size: Math.max(entries.byteLength, 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
      this.device.queue.writeBuffer(buf, 0, entries.buffer as ArrayBuffer, 0, entries.byteLength)
      this.cachedKernelBuf = buf
      this.cachedKernelKey = key
      this.cachedKernelCount = entries.length / 4
    }
    const paramsBuf = this.makeParamsBuf(new Uint32Array([this.cachedKernelCount, 0, 0, 0]))
    this.encodeRenderPass(encoder, this.selectPipeline(this.lensBlurPipeline, dstTex), [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: paramsBuf } },
      { binding: 3, resource: { buffer: this.cachedKernelBuf! } },
    ], dstTex)
  }

  encodeSharpen(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number): void {
    this.encodeRenderPass(encoder, this.selectPipeline(this.sharpenPipeline, dstTex), [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.sampler },
    ], dstTex)
  }

  encodeSharpenMore(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number): void {
    this.encodeRenderPass(encoder, this.selectPipeline(this.sharpenMorePipeline, dstTex), [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.sampler },
    ], dstTex)
  }

  encodeUnsharpMask(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, amount: number, radius: number, threshold: number): void {
    const gaussParamsBuf = this.makeParamsBuf(new Uint32Array([radius, 0, 0, 0]))
    const blurredTex = this.makeRgba8Tex(w, h)
    this.encodeRenderPass(encoder, this.selectPipeline(this.gaussianHPipeline, this.intermediate0), [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: gaussParamsBuf } },
    ], this.intermediate0)
    this.encodeRenderPass(encoder, this.gaussianVPipeline.s8, [
      { binding: 0, resource: this.intermediate0.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: gaussParamsBuf } },
    ], blurredTex)
    const combineParamsBuf = this.makeParamsBuf(new Uint32Array([amount, threshold, 0, 0]))
    this.encodeRenderPass(encoder, this.selectPipeline(this.unsharpCombinePipeline, dstTex), [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: blurredTex.createView() },
      { binding: 3, resource: { buffer: combineParamsBuf } },
    ], dstTex)
  }

  encodeSmartSharpen(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, amount: number, radius: number, reduceNoise: number, remove: number): void {
    if (remove === 0) {
      const gaussParamsBuf = this.makeParamsBuf(new Uint32Array([radius, 0, 0, 0]))
      const blurredTex = this.makeRgba8Tex(w, h)
      this.encodeRenderPass(encoder, this.selectPipeline(this.gaussianHPipeline, this.intermediate0), [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: gaussParamsBuf } },
      ], this.intermediate0)
      this.encodeRenderPass(encoder, this.gaussianVPipeline.s8, [
        { binding: 0, resource: this.intermediate0.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: gaussParamsBuf } },
      ], blurredTex)
      if (reduceNoise > 0) {
        const sharpenedTex = this.makeRgba8Tex(w, h)
        const combineParamsBuf = this.makeParamsBuf(new Uint32Array([amount, 0, 0, 0]))
        this.encodeRenderPass(encoder, this.smartSharpenGaussCombinePipeline.s8, [
          { binding: 0, resource: srcTex.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: blurredTex.createView() },
          { binding: 3, resource: { buffer: combineParamsBuf } },
        ], sharpenedTex)
        const boxParamsBuf = this.makeParamsBuf(new Uint32Array([1, 0, 0, 0]))
        const smoothedTex = this.makeRgba8Tex(w, h)
        this.encodeRenderPass(encoder, this.selectPipeline(this.boxHPipeline, this.intermediate0), [
          { binding: 0, resource: sharpenedTex.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: boxParamsBuf } },
        ], this.intermediate0)
        this.encodeRenderPass(encoder, this.boxVPipeline.s8, [
          { binding: 0, resource: this.intermediate0.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: boxParamsBuf } },
        ], smoothedTex)
        const blendParamsBuf = this.makeParamsBuf(new Uint32Array([reduceNoise, 0, 0, 0]))
        this.encodeRenderPass(encoder, this.selectPipeline(this.smartSharpenBlendPipeline, dstTex), [
          { binding: 0, resource: sharpenedTex.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: smoothedTex.createView() },
          { binding: 3, resource: { buffer: blendParamsBuf } },
        ], dstTex)
      } else {
        const combineParamsBuf = this.makeParamsBuf(new Uint32Array([amount, 0, 0, 0]))
        this.encodeRenderPass(encoder, this.selectPipeline(this.smartSharpenGaussCombinePipeline, dstTex), [
          { binding: 0, resource: srcTex.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: blurredTex.createView() },
          { binding: 3, resource: { buffer: combineParamsBuf } },
        ], dstTex)
      }
    } else {
      if (reduceNoise > 0) {
        const sharpenedTex = this.makeRgba8Tex(w, h)
        const lensParamsBuf = this.makeParamsBuf(new Uint32Array([amount, 0, 0, 0]))
        this.encodeRenderPass(encoder, this.smartSharpenLensPipeline.s8, [
          { binding: 0, resource: srcTex.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: lensParamsBuf } },
        ], sharpenedTex)
        const boxParamsBuf = this.makeParamsBuf(new Uint32Array([1, 0, 0, 0]))
        const smoothedTex = this.makeRgba8Tex(w, h)
        this.encodeRenderPass(encoder, this.selectPipeline(this.boxHPipeline, this.intermediate0), [
          { binding: 0, resource: sharpenedTex.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: boxParamsBuf } },
        ], this.intermediate0)
        this.encodeRenderPass(encoder, this.boxVPipeline.s8, [
          { binding: 0, resource: this.intermediate0.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: boxParamsBuf } },
        ], smoothedTex)
        const blendParamsBuf = this.makeParamsBuf(new Uint32Array([reduceNoise, 0, 0, 0]))
        this.encodeRenderPass(encoder, this.selectPipeline(this.smartSharpenBlendPipeline, dstTex), [
          { binding: 0, resource: sharpenedTex.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: smoothedTex.createView() },
          { binding: 3, resource: { buffer: blendParamsBuf } },
        ], dstTex)
      } else {
        const lensParamsBuf = this.makeParamsBuf(new Uint32Array([amount, 0, 0, 0]))
        this.encodeRenderPass(encoder, this.selectPipeline(this.smartSharpenLensPipeline, dstTex), [
          { binding: 0, resource: srcTex.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: lensParamsBuf } },
        ], dstTex)
      }
    }
  }

  encodeAddNoise(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, amount: number, distribution: number, monochromatic: number, seed: number): void {
    const paramsBuf = this.makeParamsBuf(new Uint32Array([amount, distribution, monochromatic, seed]))
    this.encodeRenderPass(encoder, this.selectPipeline(this.addNoisePipeline, dstTex), [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], dstTex)
  }

  encodeFilmGrain(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, grainSize: number, intensity: number, roughness: number, seed: number): void {
    const blurRadius = grainSize > 1 ? Math.min(5, Math.floor(grainSize / 10)) : 0
    const noiseTexA = this.makeRgba8Tex(w, h)
    const noiseParamsBuf = this.makeParamsBuf(new Uint32Array([seed, w, 0, 0]))
    this.encodeRenderPass(encoder, this.filmGrainNoisePipeline, [
      { binding: 0, resource: { buffer: noiseParamsBuf } },
    ], noiseTexA)
    let finalNoiseTex = noiseTexA
    if (blurRadius > 0) {
      const noiseTexB = this.makeRgba8Tex(w, h)
      const blurParamsBuf = this.makeParamsBuf(new Uint32Array([blurRadius, 0, 0, 0]))
      this.encodeRenderPass(encoder, this.selectPipeline(this.boxHPipeline, this.intermediate0), [
        { binding: 0, resource: noiseTexA.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: blurParamsBuf } },
      ], this.intermediate0)
      this.encodeRenderPass(encoder, this.boxVPipeline.s8, [
        { binding: 0, resource: this.intermediate0.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: blurParamsBuf } },
      ], noiseTexB)
      finalNoiseTex = noiseTexB
    }
    const combineParamsBuf = this.makeParamsBuf(new Uint32Array([intensity, roughness, 0, 0]))
    this.encodeRenderPass(encoder, this.selectPipeline(this.filmGrainCombinePipeline, dstTex), [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: finalNoiseTex.createView() },
      { binding: 3, resource: { buffer: combineParamsBuf } },
    ], dstTex)
  }

  encodeMedian(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, radius: number): void {
    const paramsBuf = this.makeParamsBuf(new Uint32Array([radius, 0, 0, 0]))
    this.encodeRenderPass(encoder, this.selectPipeline(this.medianPipeline, dstTex), [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], dstTex)
  }

  encodeBilateral(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, radius: number, sigmaSpatial: number, sigmaColor: number): void {
    const buf = new ArrayBuffer(16)
    const dv = new DataView(buf)
    dv.setUint32(0, radius, true); dv.setUint32(4, 0, true)
    dv.setFloat32(8, sigmaSpatial, true); dv.setFloat32(12, sigmaColor, true)
    const paramsBuf = this.makeParamsBuf(buf)
    this.encodeRenderPass(encoder, this.selectPipeline(this.bilateralPipeline, dstTex), [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], dstTex)
  }

  encodeReduceNoise(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, strength: number, preserveDetails: number, reduceColorNoise: number, sharpenDetails: number): void {
    if (sharpenDetails > 0) {
      const tempTex = this.makeRgba8Tex(w, h)
      const rndParamsBuf = this.makeParamsBuf(new Uint32Array([strength, preserveDetails, reduceColorNoise, 0]))
      this.encodeRenderPass(encoder, this.reduceNoisePipeline.s8, [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: rndParamsBuf } },
      ], tempTex)
      const gaussParamsBuf = this.makeParamsBuf(new Uint32Array([1, 0, 0, 0]))
      const blurredTex = this.makeRgba8Tex(w, h)
      this.encodeRenderPass(encoder, this.selectPipeline(this.gaussianHPipeline, this.intermediate0), [
        { binding: 0, resource: tempTex.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: gaussParamsBuf } },
      ], this.intermediate0)
      this.encodeRenderPass(encoder, this.gaussianVPipeline.s8, [
        { binding: 0, resource: this.intermediate0.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: gaussParamsBuf } },
      ], blurredTex)
      const unsharpParamsBuf = this.makeParamsBuf(new Uint32Array([Math.round(sharpenDetails * 1.5), 0, 0, 0]))
      this.encodeRenderPass(encoder, this.selectPipeline(this.unsharpCombinePipeline, dstTex), [
        { binding: 0, resource: tempTex.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: blurredTex.createView() },
        { binding: 3, resource: { buffer: unsharpParamsBuf } },
      ], dstTex)
    } else {
      const rndParamsBuf = this.makeParamsBuf(new Uint32Array([strength, preserveDetails, reduceColorNoise, 0]))
      this.encodeRenderPass(encoder, this.selectPipeline(this.reduceNoisePipeline, dstTex), [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: rndParamsBuf } },
      ], dstTex)
    }
  }

  encodeClouds(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, scale: number, opacity: number, colorMode: number, fgColor: number, bgColor: number, seed: number): void {
    const paramsData = new Uint32Array([scale, opacity, colorMode, fgColor, bgColor, w, h, 0])
    const paramsBuf = this.makeParamsBuf(paramsData)
    const perm = new Uint32Array(256)
    for (let i = 0; i < 256; i++) perm[i] = i
    let s = (seed ^ 0xDEADBEEF) >>> 0
    for (let i = 255; i > 0; i--) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      const idx = s % (i + 1)
      const tmp = perm[i]; perm[i] = perm[idx]; perm[idx] = tmp
    }
    const permBuf = this.device.createBuffer({ size: Math.max(perm.byteLength, 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(permBuf, 0, perm)
    this.pendingDestroyBuffers.push(permBuf)
    this.encodeRenderPass(encoder, this.selectPipeline(this.cloudsPipeline, dstTex), [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: paramsBuf } },
      { binding: 3, resource: { buffer: permBuf } },
    ], dstTex)
  }

  encodePixelate(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, blockSize: number): void {
    const paramsBuf = this.makeParamsBuf(new Uint32Array([blockSize, 0, 0, 0]))
    this.encodeRenderPass(encoder, this.selectPipeline(this.pixelatePipeline, dstTex), [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], dstTex)
  }

}

// ─── Module-level singleton ───────────────────────────────────────────────────

let _engine: FilterComputeEngine | null = null

export function initFilterCompute(device: GPUDevice, width: number, height: number, format: GPUTextureFormat = 'rgba8unorm'): void {
  _engine?.destroy()
  _engine = FilterComputeEngine.create(device, width, height, format)
}

export async function gaussianBlur(pixels: Uint8Array, width: number, height: number, radius: number): Promise<Uint8Array> { return _engine!.gaussianBlur(pixels, width, height, radius) }
export async function boxBlur(pixels: Uint8Array, width: number, height: number, radius: number): Promise<Uint8Array> { return _engine!.boxBlur(pixels, width, height, radius) }
export async function radialBlur(pixels: Uint8Array, width: number, height: number, mode: number, amount: number, centerX: number, centerY: number, quality: number): Promise<Uint8Array> { return _engine!.radialBlur(pixels, width, height, mode, amount, centerX, centerY, quality) }
export async function motionBlur(pixels: Uint8Array, width: number, height: number, angleDeg: number, distance: number): Promise<Uint8Array> { return _engine!.motionBlur(pixels, width, height, angleDeg, distance) }
export async function lensBlur(pixels: Uint8Array, width: number, height: number, radius: number, bladeCount: number, bladeCurvature: number, rotation: number): Promise<Uint8Array> { return _engine!.lensBlur(pixels, width, height, radius, bladeCount, bladeCurvature, rotation) }
export async function sharpen(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> { return _engine!.sharpen(pixels, width, height) }
export async function sharpenMore(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> { return _engine!.sharpenMore(pixels, width, height) }
export async function unsharpMask(pixels: Uint8Array, width: number, height: number, amount: number, radius: number, threshold: number): Promise<Uint8Array> { return _engine!.unsharpMask(pixels, width, height, amount, radius, threshold) }
export async function smartSharpen(pixels: Uint8Array, width: number, height: number, amount: number, radius: number, reduceNoise: number, remove: number): Promise<Uint8Array> { return _engine!.smartSharpen(pixels, width, height, amount, radius, reduceNoise, remove) }
export async function addNoise(pixels: Uint8Array, width: number, height: number, amount: number, distribution: number, monochromatic: number, seed: number): Promise<Uint8Array> { return _engine!.addNoise(pixels, width, height, amount, distribution, monochromatic, seed) }
export async function filmGrain(pixels: Uint8Array, width: number, height: number, grainSize: number, intensity: number, roughness: number, seed: number): Promise<Uint8Array> { return _engine!.filmGrain(pixels, width, height, grainSize, intensity, roughness, seed) }
export async function clouds(pixels: Uint8Array, width: number, height: number, scale: number, opacity: number, colorMode: number, fgR: number, fgG: number, fgB: number, bgR: number, bgG: number, bgB: number, seed: number): Promise<Uint8Array> { return _engine!.clouds(pixels, width, height, scale, opacity, colorMode, fgR, fgG, fgB, bgR, bgG, bgB, seed) }
export async function median(pixels: Uint8Array, width: number, height: number, radius: number): Promise<Uint8Array> { return _engine!.median(pixels, width, height, radius) }
export async function bilateral(pixels: Uint8Array, width: number, height: number, radius: number, sigmaSpatial: number, sigmaColor: number): Promise<Uint8Array> { return _engine!.bilateral(pixels, width, height, radius, sigmaSpatial, sigmaColor) }
export async function reduceNoise(pixels: Uint8Array, width: number, height: number, strength: number, preserveDetails: number, reduceColorNoise: number, sharpenDetails: number): Promise<Uint8Array> { return _engine!.reduceNoise(pixels, width, height, strength, preserveDetails, reduceColorNoise, sharpenDetails) }
export async function renderLensFlare(width: number, height: number, centerX: number, centerY: number, brightness: number, lensType: number, ringOpacity: number, streakStrength: number, streakWidth: number, streakRotation: number): Promise<Uint8Array> { return _engine!.renderLensFlare(width, height, centerX, centerY, brightness, lensType, ringOpacity, streakStrength, streakWidth, streakRotation) }
export async function pixelate(pixels: Uint8Array, width: number, height: number, blockSize: number): Promise<Uint8Array> { return _engine!.pixelate(pixels, width, height, blockSize) }

export function encodeGaussianBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, radius: number): void { _engine!.encodeGaussianBlur(encoder, srcTex, dstTex, w, h, radius) }
export function encodeBoxBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, radius: number): void { _engine!.encodeBoxBlur(encoder, srcTex, dstTex, w, h, radius) }
export function encodeRadialBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, mode: number, amount: number, centerX: number, centerY: number, quality: number): void { _engine!.encodeRadialBlur(encoder, srcTex, dstTex, w, h, mode, amount, centerX, centerY, quality) }
export function encodeMotionBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, angle: number, distance: number): void { _engine!.encodeMotionBlur(encoder, srcTex, dstTex, w, h, angle, distance) }
export function encodeRemoveMotionBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, angle: number, distance: number, noiseReduction: number): void { _engine!.encodeRemoveMotionBlur(encoder, srcTex, dstTex, w, h, angle, distance, noiseReduction) }
export function encodeLensBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, radius: number, bladeCount: number, bladeCurvature: number, rotation: number): void { _engine!.encodeLensBlur(encoder, srcTex, dstTex, w, h, radius, bladeCount, bladeCurvature, rotation) }
export function encodeSharpen(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number): void { _engine!.encodeSharpen(encoder, srcTex, dstTex, w, h) }
export function encodeSharpenMore(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number): void { _engine!.encodeSharpenMore(encoder, srcTex, dstTex, w, h) }
export function encodeUnsharpMask(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, amount: number, radius: number, threshold: number): void { _engine!.encodeUnsharpMask(encoder, srcTex, dstTex, w, h, amount, radius, threshold) }
export function encodeSmartSharpen(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, amount: number, radius: number, reduceNoise: number, remove: number): void { _engine!.encodeSmartSharpen(encoder, srcTex, dstTex, w, h, amount, radius, reduceNoise, remove) }
export function encodeAddNoise(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, amount: number, distribution: number, monochromatic: number, seed: number): void { _engine!.encodeAddNoise(encoder, srcTex, dstTex, w, h, amount, distribution, monochromatic, seed) }
export function encodeFilmGrain(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, grainSize: number, intensity: number, roughness: number, seed: number): void { _engine!.encodeFilmGrain(encoder, srcTex, dstTex, w, h, grainSize, intensity, roughness, seed) }
export function encodeMedian(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, radius: number): void { _engine!.encodeMedian(encoder, srcTex, dstTex, w, h, radius) }
export function encodeBilateral(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, radius: number, sigmaSpatial: number, sigmaColor: number): void { _engine!.encodeBilateral(encoder, srcTex, dstTex, w, h, radius, sigmaSpatial, sigmaColor) }
export function encodeReduceNoise(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, strength: number, preserveDetails: number, reduceColorNoise: number, sharpenDetails: number): void { _engine!.encodeReduceNoise(encoder, srcTex, dstTex, w, h, strength, preserveDetails, reduceColorNoise, sharpenDetails) }
export function encodeClouds(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, scale: number, opacity: number, colorMode: number, fgColor: number, bgColor: number, seed: number): void { _engine!.encodeClouds(encoder, srcTex, dstTex, w, h, scale, opacity, colorMode, fgColor, bgColor, seed) }
export function encodePixelate(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, blockSize: number): void { _engine!.encodePixelate(encoder, srcTex, dstTex, w, h, blockSize) }

export function flushFilterComputeDestroys(): void { _engine?.flushPendingDestroys() }
