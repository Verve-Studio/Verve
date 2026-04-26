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
import { removeMotionBlur as wasmRemoveMotionBlur } from '../../../wasm/index'

// ─── Engine ───────────────────────────────────────────────────────────────────

class FilterComputeEngine {
  private readonly device: GPUDevice
  private readonly gaussianHPipeline: GPUComputePipeline
  private readonly gaussianVPipeline: GPUComputePipeline
  private readonly boxHPipeline: GPUComputePipeline
  private readonly boxVPipeline: GPUComputePipeline
  private readonly radialBlurPipeline: GPUComputePipeline
  private readonly motionBlurPipeline: GPUComputePipeline
  private readonly lensBlurPipeline: GPUComputePipeline
  private readonly sharpenPipeline: GPUComputePipeline
  private readonly sharpenMorePipeline: GPUComputePipeline
  private readonly unsharpCombinePipeline: GPUComputePipeline
  private readonly smartSharpenGaussCombinePipeline: GPUComputePipeline
  private readonly smartSharpenLensPipeline: GPUComputePipeline
  private readonly smartSharpenBlendPipeline: GPUComputePipeline
  private readonly addNoisePipeline: GPUComputePipeline
  private readonly filmGrainNoisePipeline: GPUComputePipeline
  private readonly filmGrainCombinePipeline: GPUComputePipeline
  private readonly cloudsPipeline: GPUComputePipeline
  private readonly medianPipeline: GPUComputePipeline
  private readonly bilateralPipeline: GPUComputePipeline
  private readonly reduceNoisePipeline: GPUComputePipeline
  private readonly lensFlareRenderPipeline: GPUComputePipeline
  private readonly pixelatePipeline: GPUComputePipeline
  private readonly intermediate0: GPUTexture
  private cachedKernelKey: string = ''
  private cachedKernelBuf: GPUBuffer | null = null
  private cachedKernelCount: number = 0
  pendingDestroyBuffers: GPUBuffer[] = []
  pendingDestroyTextures: GPUTexture[] = []
  private rmbCache: Map<string, { hash: string; tex: GPUTexture }> = new Map()
  rmbPendingBakes: Set<string> = new Set()

  private constructor(device: GPUDevice, width: number, height: number) {
    this.device = device
    this.intermediate0 = device.createTexture({
      size: { width, height },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    })
    this.gaussianHPipeline = this.makePipeline(FILTER_GAUSSIAN_H_COMPUTE, 'cs_gaussian_h')
    this.gaussianVPipeline = this.makePipeline(FILTER_GAUSSIAN_V_COMPUTE, 'cs_gaussian_v')
    this.boxHPipeline = this.makePipeline(FILTER_BOX_H_COMPUTE, 'cs_box_h')
    this.boxVPipeline = this.makePipeline(FILTER_BOX_V_COMPUTE, 'cs_box_v')
    this.radialBlurPipeline = this.makePipeline(FILTER_RADIAL_BLUR_COMPUTE, 'cs_radial_blur')
    this.motionBlurPipeline = this.makePipeline(FILTER_MOTION_BLUR_COMPUTE, 'cs_motion_blur')
    this.lensBlurPipeline = this.makePipeline(FILTER_LENS_BLUR_COMPUTE, 'cs_lens_blur')
    this.sharpenPipeline = this.makePipeline(FILTER_SHARPEN_COMPUTE, 'cs_sharpen')
    this.sharpenMorePipeline = this.makePipeline(FILTER_SHARPEN_MORE_COMPUTE, 'cs_sharpen_more')
    this.unsharpCombinePipeline = this.makePipeline(FILTER_UNSHARP_COMBINE_COMPUTE, 'cs_unsharp_combine')
    this.smartSharpenGaussCombinePipeline = this.makePipeline(FILTER_SMART_SHARPEN_GAUSS_COMBINE_COMPUTE, 'cs_smart_sharpen_gauss')
    this.smartSharpenLensPipeline = this.makePipeline(FILTER_SMART_SHARPEN_LENS_COMPUTE, 'cs_smart_sharpen_lens')
    this.smartSharpenBlendPipeline = this.makePipeline(FILTER_SMART_SHARPEN_BLEND_COMPUTE, 'cs_smart_sharpen_blend')
    this.addNoisePipeline = this.makePipeline(FILTER_ADD_NOISE_COMPUTE, 'cs_add_noise')
    this.filmGrainNoisePipeline = this.makePipeline(FILTER_FILM_GRAIN_NOISE_COMPUTE, 'cs_film_grain_noise')
    this.filmGrainCombinePipeline = this.makePipeline(FILTER_FILM_GRAIN_COMBINE_COMPUTE, 'cs_film_grain_combine')
    this.cloudsPipeline = this.makePipeline(FILTER_CLOUDS_COMPUTE, 'cs_clouds')
    this.medianPipeline = this.makePipeline(FILTER_MEDIAN_COMPUTE, 'cs_median')
    this.bilateralPipeline = this.makePipeline(FILTER_BILATERAL_COMPUTE, 'cs_bilateral')
    this.reduceNoisePipeline = this.makePipeline(FILTER_REDUCE_NOISE_COMPUTE, 'cs_reduce_noise')
    this.lensFlareRenderPipeline = this.makePipeline(FILTER_LENS_FLARE_COMPUTE, 'cs_lens_flare')
    this.pixelatePipeline = this.makePipeline(FILTER_PIXELATE_COMPUTE, 'cs_pixelate')
  }

  static create(device: GPUDevice, width: number, height: number): FilterComputeEngine {
    return new FilterComputeEngine(device, width, height)
  }

  destroy(): void {
    this.intermediate0.destroy()
    this.cachedKernelBuf?.destroy()
    this.cachedKernelBuf = null
    for (const [, entry] of this.rmbCache) entry.tex.destroy()
    this.rmbCache.clear()
  }

  private makePipeline(wgsl: string, entryPoint: string): GPUComputePipeline {
    const module = this.device.createShaderModule({ code: wgsl })
    return this.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } })
  }

  async gaussianBlur(pixels: Uint8Array, width: number, height: number, radius: number): Promise<Uint8Array> {
    return runGaussianBlur(this.device, this.gaussianHPipeline, this.gaussianVPipeline, this.intermediate0, pixels, width, height, radius)
  }

  async boxBlur(pixels: Uint8Array, width: number, height: number, radius: number): Promise<Uint8Array> {
    return runBoxBlur(this.device, this.boxHPipeline, this.boxVPipeline, this.intermediate0, pixels, width, height, radius)
  }

  async radialBlur(pixels: Uint8Array, width: number, height: number, mode: number, amount: number, centerX: number, centerY: number, quality: number): Promise<Uint8Array> {
    return runRadialBlur(this.device, this.radialBlurPipeline, pixels, width, height, mode, amount, centerX, centerY, quality)
  }

  async motionBlur(pixels: Uint8Array, width: number, height: number, angleDeg: number, distance: number): Promise<Uint8Array> {
    return runMotionBlur(this.device, this.motionBlurPipeline, pixels, width, height, angleDeg, distance)
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
    return runLensBlur(this.device, this.lensBlurPipeline, pixels, width, height, this.cachedKernelBuf!, this.cachedKernelCount)
  }

  async sharpen(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
    return runSharpen(this.device, this.sharpenPipeline, pixels, width, height)
  }

  async sharpenMore(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
    return runSharpenMore(this.device, this.sharpenMorePipeline, pixels, width, height)
  }

  async unsharpMask(pixels: Uint8Array, width: number, height: number, amount: number, radius: number, threshold: number): Promise<Uint8Array> {
    return runUnsharpMask(this.device, this.gaussianHPipeline, this.gaussianVPipeline, this.unsharpCombinePipeline, this.intermediate0, pixels, width, height, amount, radius, threshold)
  }

  async smartSharpen(pixels: Uint8Array, width: number, height: number, amount: number, radius: number, reduceNoise: number, remove: number): Promise<Uint8Array> {
    return runSmartSharpen(this.device, this.gaussianHPipeline, this.gaussianVPipeline, this.boxHPipeline, this.boxVPipeline, this.smartSharpenGaussCombinePipeline, this.smartSharpenLensPipeline, this.smartSharpenBlendPipeline, this.intermediate0, pixels, width, height, amount, radius, reduceNoise, remove)
  }

  async addNoise(pixels: Uint8Array, width: number, height: number, amount: number, distribution: number, monochromatic: number, seed: number): Promise<Uint8Array> {
    return runAddNoise(this.device, this.addNoisePipeline, pixels, width, height, amount, distribution, monochromatic, seed)
  }

  async filmGrain(pixels: Uint8Array, width: number, height: number, grainSize: number, intensity: number, roughness: number, seed: number): Promise<Uint8Array> {
    return runFilmGrain(this.device, this.filmGrainNoisePipeline, this.filmGrainCombinePipeline, this.boxHPipeline, this.boxVPipeline, this.intermediate0, pixels, width, height, grainSize, intensity, roughness, seed)
  }

  async clouds(pixels: Uint8Array, width: number, height: number, scale: number, opacity: number, colorMode: number, fgR: number, fgG: number, fgB: number, bgR: number, bgG: number, bgB: number, seed: number): Promise<Uint8Array> {
    return runClouds(this.device, this.cloudsPipeline, pixels, width, height, scale, opacity, colorMode, fgR, fgG, fgB, bgR, bgG, bgB, seed)
  }

  async median(pixels: Uint8Array, width: number, height: number, radius: number): Promise<Uint8Array> {
    return runMedian(this.device, this.medianPipeline, pixels, width, height, radius)
  }

  async bilateral(pixels: Uint8Array, width: number, height: number, radius: number, sigmaSpatial: number, sigmaColor: number): Promise<Uint8Array> {
    return runBilateral(this.device, this.bilateralPipeline, pixels, width, height, radius, sigmaSpatial, sigmaColor)
  }

  async reduceNoise(pixels: Uint8Array, width: number, height: number, strength: number, preserveDetails: number, reduceColorNoise: number, sharpenDetails: number): Promise<Uint8Array> {
    return runReduceNoise(this.device, this.reduceNoisePipeline, pixels, width, height, strength, preserveDetails, reduceColorNoise, sharpenDetails, (p, w, h, a, r, t) => this.unsharpMask(p, w, h, a, r, t))
  }

  async renderLensFlare(width: number, height: number, centerX: number, centerY: number, brightness: number, lensType: number, ringOpacity: number, streakStrength: number, streakWidth: number, streakRotation: number): Promise<Uint8Array> {
    return runRenderLensFlare(this.device, this.lensFlareRenderPipeline, width, height, centerX, centerY, brightness, lensType, ringOpacity, streakStrength, streakWidth, streakRotation)
  }

  async pixelate(pixels: Uint8Array, width: number, height: number, blockSize: number): Promise<Uint8Array> {
    return runPixelate(this.device, this.pixelatePipeline, pixels, width, height, blockSize)
  }

  // ─── Encode methods (synchronous, record into an existing GPUCommandEncoder) ──

  flushPendingDestroys(): void {
    for (const buf of this.pendingDestroyBuffers) buf.destroy()
    this.pendingDestroyBuffers = []
    for (const tex of this.pendingDestroyTextures) tex.destroy()
    this.pendingDestroyTextures = []
  }

  private makeRgba8Tex(w: number, h: number): GPUTexture {
    const tex = this.device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
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

  private encodePass(encoder: GPUCommandEncoder, pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[], wgX: number, wgY: number): void {
    const bg = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries })
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bg)
    pass.dispatchWorkgroups(wgX, wgY)
    pass.end()
  }

  encodeGaussianBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, radius: number): void {
    const paramsBuf = this.makeParamsBuf(new Uint32Array([radius, 0, 0, 0]))
    const wgx = Math.ceil(w / 8); const wgy = Math.ceil(h / 8)
    this.encodePass(encoder, this.gaussianHPipeline, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.intermediate0.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], wgx, wgy)
    this.encodePass(encoder, this.gaussianVPipeline, [
      { binding: 0, resource: this.intermediate0.createView() },
      { binding: 1, resource: dstTex.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], wgx, wgy)
  }

  encodeBoxBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, radius: number): void {
    const paramsBuf = this.makeParamsBuf(new Uint32Array([radius, 0, 0, 0]))
    const wgx = Math.ceil(w / 8); const wgy = Math.ceil(h / 8)
    this.encodePass(encoder, this.boxHPipeline, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.intermediate0.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], wgx, wgy)
    this.encodePass(encoder, this.boxVPipeline, [
      { binding: 0, resource: this.intermediate0.createView() },
      { binding: 1, resource: dstTex.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], wgx, wgy)
  }

  encodeRadialBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, mode: number, amount: number, centerX: number, centerY: number, quality: number): void {
    const buf = new ArrayBuffer(32)
    const dv = new DataView(buf)
    dv.setUint32(0, mode, true); dv.setUint32(4, amount, true); dv.setUint32(8, quality, true); dv.setUint32(12, 0, true)
    dv.setFloat32(16, centerX, true); dv.setFloat32(20, centerY, true); dv.setFloat32(24, 0, true); dv.setFloat32(28, 0, true)
    const paramsBuf = this.makeParamsBuf(buf)
    this.encodePass(encoder, this.radialBlurPipeline, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: dstTex.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], Math.ceil(w / 8), Math.ceil(h / 8))
  }

  encodeMotionBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, angle: number, distance: number): void {
    const buf = new ArrayBuffer(16)
    const dv = new DataView(buf)
    dv.setFloat32(0, angle, true); dv.setUint32(4, distance, true); dv.setUint32(8, 0, true); dv.setUint32(12, 0, true)
    const paramsBuf = this.makeParamsBuf(buf)
    this.encodePass(encoder, this.motionBlurPipeline, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: dstTex.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], Math.ceil(w / 8), Math.ceil(h / 8))
  }

  encodeRemoveMotionBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, layerId: string): void {
    const cached = this.rmbCache.get(layerId)
    encoder.copyTextureToTexture(
      { texture: cached != null ? cached.tex : srcTex, mipLevel: 0 },
      { texture: dstTex, mipLevel: 0 },
      { width: w, height: h, depthOrArrayLayers: 1 },
    )
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
    this.encodePass(encoder, this.lensBlurPipeline, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: dstTex.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
      { binding: 3, resource: { buffer: this.cachedKernelBuf! } },
    ], Math.ceil(w / 16), Math.ceil(h / 16))
  }

  encodeSharpen(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number): void {
    this.encodePass(encoder, this.sharpenPipeline, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: dstTex.createView() },
    ], Math.ceil(w / 8), Math.ceil(h / 8))
  }

  encodeSharpenMore(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number): void {
    this.encodePass(encoder, this.sharpenMorePipeline, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: dstTex.createView() },
    ], Math.ceil(w / 8), Math.ceil(h / 8))
  }

  encodeUnsharpMask(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, amount: number, radius: number, threshold: number): void {
    const wgx = Math.ceil(w / 8); const wgy = Math.ceil(h / 8)
    const gaussParamsBuf = this.makeParamsBuf(new Uint32Array([radius, 0, 0, 0]))
    const blurredTex = this.makeRgba8Tex(w, h)
    this.encodePass(encoder, this.gaussianHPipeline, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.intermediate0.createView() },
      { binding: 2, resource: { buffer: gaussParamsBuf } },
    ], wgx, wgy)
    this.encodePass(encoder, this.gaussianVPipeline, [
      { binding: 0, resource: this.intermediate0.createView() },
      { binding: 1, resource: blurredTex.createView() },
      { binding: 2, resource: { buffer: gaussParamsBuf } },
    ], wgx, wgy)
    const combineParamsBuf = this.makeParamsBuf(new Uint32Array([amount, threshold, 0, 0]))
    this.encodePass(encoder, this.unsharpCombinePipeline, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: blurredTex.createView() },
      { binding: 2, resource: dstTex.createView() },
      { binding: 3, resource: { buffer: combineParamsBuf } },
    ], wgx, wgy)
  }

  encodeSmartSharpen(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, amount: number, radius: number, reduceNoise: number, remove: number): void {
    const wgx = Math.ceil(w / 8); const wgy = Math.ceil(h / 8)
    if (remove === 0) {
      const gaussParamsBuf = this.makeParamsBuf(new Uint32Array([radius, 0, 0, 0]))
      const blurredTex = this.makeRgba8Tex(w, h)
      this.encodePass(encoder, this.gaussianHPipeline, [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: this.intermediate0.createView() },
        { binding: 2, resource: { buffer: gaussParamsBuf } },
      ], wgx, wgy)
      this.encodePass(encoder, this.gaussianVPipeline, [
        { binding: 0, resource: this.intermediate0.createView() },
        { binding: 1, resource: blurredTex.createView() },
        { binding: 2, resource: { buffer: gaussParamsBuf } },
      ], wgx, wgy)
      if (reduceNoise > 0) {
        const sharpenedTex = this.makeRgba8Tex(w, h)
        const combineParamsBuf = this.makeParamsBuf(new Uint32Array([amount, 0, 0, 0]))
        this.encodePass(encoder, this.smartSharpenGaussCombinePipeline, [
          { binding: 0, resource: srcTex.createView() },
          { binding: 1, resource: blurredTex.createView() },
          { binding: 2, resource: sharpenedTex.createView() },
          { binding: 3, resource: { buffer: combineParamsBuf } },
        ], wgx, wgy)
        const boxParamsBuf = this.makeParamsBuf(new Uint32Array([1, 0, 0, 0]))
        const smoothedTex = this.makeRgba8Tex(w, h)
        this.encodePass(encoder, this.boxHPipeline, [
          { binding: 0, resource: sharpenedTex.createView() },
          { binding: 1, resource: this.intermediate0.createView() },
          { binding: 2, resource: { buffer: boxParamsBuf } },
        ], wgx, wgy)
        this.encodePass(encoder, this.boxVPipeline, [
          { binding: 0, resource: this.intermediate0.createView() },
          { binding: 1, resource: smoothedTex.createView() },
          { binding: 2, resource: { buffer: boxParamsBuf } },
        ], wgx, wgy)
        const blendParamsBuf = this.makeParamsBuf(new Uint32Array([reduceNoise, 0, 0, 0]))
        this.encodePass(encoder, this.smartSharpenBlendPipeline, [
          { binding: 0, resource: sharpenedTex.createView() },
          { binding: 1, resource: smoothedTex.createView() },
          { binding: 2, resource: dstTex.createView() },
          { binding: 3, resource: { buffer: blendParamsBuf } },
        ], wgx, wgy)
      } else {
        const combineParamsBuf = this.makeParamsBuf(new Uint32Array([amount, 0, 0, 0]))
        this.encodePass(encoder, this.smartSharpenGaussCombinePipeline, [
          { binding: 0, resource: srcTex.createView() },
          { binding: 1, resource: blurredTex.createView() },
          { binding: 2, resource: dstTex.createView() },
          { binding: 3, resource: { buffer: combineParamsBuf } },
        ], wgx, wgy)
      }
    } else {
      if (reduceNoise > 0) {
        const sharpenedTex = this.makeRgba8Tex(w, h)
        const lensParamsBuf = this.makeParamsBuf(new Uint32Array([amount, 0, 0, 0]))
        this.encodePass(encoder, this.smartSharpenLensPipeline, [
          { binding: 0, resource: srcTex.createView() },
          { binding: 1, resource: sharpenedTex.createView() },
          { binding: 2, resource: { buffer: lensParamsBuf } },
        ], wgx, wgy)
        const boxParamsBuf = this.makeParamsBuf(new Uint32Array([1, 0, 0, 0]))
        const smoothedTex = this.makeRgba8Tex(w, h)
        this.encodePass(encoder, this.boxHPipeline, [
          { binding: 0, resource: sharpenedTex.createView() },
          { binding: 1, resource: this.intermediate0.createView() },
          { binding: 2, resource: { buffer: boxParamsBuf } },
        ], wgx, wgy)
        this.encodePass(encoder, this.boxVPipeline, [
          { binding: 0, resource: this.intermediate0.createView() },
          { binding: 1, resource: smoothedTex.createView() },
          { binding: 2, resource: { buffer: boxParamsBuf } },
        ], wgx, wgy)
        const blendParamsBuf = this.makeParamsBuf(new Uint32Array([reduceNoise, 0, 0, 0]))
        this.encodePass(encoder, this.smartSharpenBlendPipeline, [
          { binding: 0, resource: sharpenedTex.createView() },
          { binding: 1, resource: smoothedTex.createView() },
          { binding: 2, resource: dstTex.createView() },
          { binding: 3, resource: { buffer: blendParamsBuf } },
        ], wgx, wgy)
      } else {
        const lensParamsBuf = this.makeParamsBuf(new Uint32Array([amount, 0, 0, 0]))
        this.encodePass(encoder, this.smartSharpenLensPipeline, [
          { binding: 0, resource: srcTex.createView() },
          { binding: 1, resource: dstTex.createView() },
          { binding: 2, resource: { buffer: lensParamsBuf } },
        ], wgx, wgy)
      }
    }
  }

  encodeAddNoise(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, amount: number, distribution: number, monochromatic: number, seed: number): void {
    const paramsBuf = this.makeParamsBuf(new Uint32Array([amount, distribution, monochromatic, seed]))
    this.encodePass(encoder, this.addNoisePipeline, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: dstTex.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], Math.ceil(w / 8), Math.ceil(h / 8))
  }

  encodeFilmGrain(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, grainSize: number, intensity: number, roughness: number, seed: number): void {
    const blurRadius = grainSize > 1 ? Math.min(5, Math.floor(grainSize / 10)) : 0
    const noiseTexA = this.makeRgba8Tex(w, h)
    const wgx = Math.ceil(w / 8); const wgy = Math.ceil(h / 8)
    const noiseParamsBuf = this.makeParamsBuf(new Uint32Array([seed, 0, 0, 0]))
    this.encodePass(encoder, this.filmGrainNoisePipeline, [
      { binding: 0, resource: noiseTexA.createView() },
      { binding: 1, resource: { buffer: noiseParamsBuf } },
    ], wgx, wgy)
    let finalNoiseTex = noiseTexA
    if (blurRadius > 0) {
      const noiseTexB = this.makeRgba8Tex(w, h)
      const blurParamsBuf = this.makeParamsBuf(new Uint32Array([blurRadius, 0, 0, 0]))
      this.encodePass(encoder, this.boxHPipeline, [
        { binding: 0, resource: noiseTexA.createView() },
        { binding: 1, resource: this.intermediate0.createView() },
        { binding: 2, resource: { buffer: blurParamsBuf } },
      ], wgx, wgy)
      this.encodePass(encoder, this.boxVPipeline, [
        { binding: 0, resource: this.intermediate0.createView() },
        { binding: 1, resource: noiseTexB.createView() },
        { binding: 2, resource: { buffer: blurParamsBuf } },
      ], wgx, wgy)
      finalNoiseTex = noiseTexB
    }
    const combineParamsBuf = this.makeParamsBuf(new Uint32Array([intensity, roughness, 0, 0]))
    this.encodePass(encoder, this.filmGrainCombinePipeline, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: finalNoiseTex.createView() },
      { binding: 2, resource: dstTex.createView() },
      { binding: 3, resource: { buffer: combineParamsBuf } },
    ], wgx, wgy)
  }

  encodeMedian(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, radius: number): void {
    const paramsBuf = this.makeParamsBuf(new Uint32Array([radius, 0, 0, 0]))
    this.encodePass(encoder, this.medianPipeline, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: dstTex.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], Math.ceil(w / 8), Math.ceil(h / 8))
  }

  encodeBilateral(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, radius: number, sigmaSpatial: number, sigmaColor: number): void {
    const buf = new ArrayBuffer(16)
    const dv = new DataView(buf)
    dv.setUint32(0, radius, true); dv.setUint32(4, 0, true)
    dv.setFloat32(8, sigmaSpatial, true); dv.setFloat32(12, sigmaColor, true)
    const paramsBuf = this.makeParamsBuf(buf)
    this.encodePass(encoder, this.bilateralPipeline, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: dstTex.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], Math.ceil(w / 8), Math.ceil(h / 8))
  }

  encodeReduceNoise(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, strength: number, preserveDetails: number, reduceColorNoise: number, sharpenDetails: number): void {
    const wgx = Math.ceil(w / 8); const wgy = Math.ceil(h / 8)
    if (sharpenDetails > 0) {
      const tempTex = this.makeRgba8Tex(w, h)
      const rndParamsBuf = this.makeParamsBuf(new Uint32Array([strength, preserveDetails, reduceColorNoise, 0]))
      this.encodePass(encoder, this.reduceNoisePipeline, [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: tempTex.createView() },
        { binding: 2, resource: { buffer: rndParamsBuf } },
      ], wgx, wgy)
      const gaussParamsBuf = this.makeParamsBuf(new Uint32Array([1, 0, 0, 0]))
      const blurredTex = this.makeRgba8Tex(w, h)
      this.encodePass(encoder, this.gaussianHPipeline, [
        { binding: 0, resource: tempTex.createView() },
        { binding: 1, resource: this.intermediate0.createView() },
        { binding: 2, resource: { buffer: gaussParamsBuf } },
      ], wgx, wgy)
      this.encodePass(encoder, this.gaussianVPipeline, [
        { binding: 0, resource: this.intermediate0.createView() },
        { binding: 1, resource: blurredTex.createView() },
        { binding: 2, resource: { buffer: gaussParamsBuf } },
      ], wgx, wgy)
      const unsharpParamsBuf = this.makeParamsBuf(new Uint32Array([Math.round(sharpenDetails * 1.5), 0, 0, 0]))
      this.encodePass(encoder, this.unsharpCombinePipeline, [
        { binding: 0, resource: tempTex.createView() },
        { binding: 1, resource: blurredTex.createView() },
        { binding: 2, resource: dstTex.createView() },
        { binding: 3, resource: { buffer: unsharpParamsBuf } },
      ], wgx, wgy)
    } else {
      const rndParamsBuf = this.makeParamsBuf(new Uint32Array([strength, preserveDetails, reduceColorNoise, 0]))
      this.encodePass(encoder, this.reduceNoisePipeline, [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: dstTex.createView() },
        { binding: 2, resource: { buffer: rndParamsBuf } },
      ], wgx, wgy)
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
    this.encodePass(encoder, this.cloudsPipeline, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: dstTex.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
      { binding: 3, resource: { buffer: permBuf } },
    ], Math.ceil(w / 8), Math.ceil(h / 8))
  }

  encodePixelate(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, blockSize: number): void {
    const paramsBuf = this.makeParamsBuf(new Uint32Array([blockSize, w, h, 0]))
    this.encodePass(encoder, this.pixelatePipeline, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: dstTex.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
    ], Math.ceil(Math.ceil(w / blockSize) / 8), Math.ceil(Math.ceil(h / blockSize) / 8))
  }

  async bakeRemoveMotionBlur(layerId: string, pixels: Uint8Array, width: number, height: number, angle: number, distance: number, noiseReduction: number): Promise<void> {
    const result = await wasmRemoveMotionBlur(pixels, width, height, angle, distance, noiseReduction)
    const old = this.rmbCache.get(layerId)
    if (old != null) old.tex.destroy()
    const tex = this.device.createTexture({
      size: { width, height },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    })
    this.device.queue.writeTexture({ texture: tex }, result.buffer as ArrayBuffer, { bytesPerRow: width * 4 }, { width, height })
    this.rmbCache.set(layerId, { hash: `${angle}|${distance}|${noiseReduction}`, tex })
    this.rmbPendingBakes.delete(layerId)
  }

  clearRmbCache(layerId: string): void {
    const entry = this.rmbCache.get(layerId)
    if (entry != null) { entry.tex.destroy(); this.rmbCache.delete(layerId) }
    this.rmbPendingBakes.delete(layerId)
  }
}

// ─── Module-level singleton ───────────────────────────────────────────────────

let _engine: FilterComputeEngine | null = null

export function initFilterCompute(device: GPUDevice, width: number, height: number): void {
  _engine?.destroy()
  _engine = FilterComputeEngine.create(device, width, height)
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
export function encodeRemoveMotionBlur(encoder: GPUCommandEncoder, srcTex: GPUTexture, dstTex: GPUTexture, w: number, h: number, layerId: string): void { _engine!.encodeRemoveMotionBlur(encoder, srcTex, dstTex, w, h, layerId) }
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
export async function bakeRemoveMotionBlur(layerId: string, pixels: Uint8Array, width: number, height: number, angle: number, distance: number, noiseReduction: number): Promise<void> { return _engine!.bakeRemoveMotionBlur(layerId, pixels, width, height, angle, distance, noiseReduction) }
export function getRmbPendingBakes(): Set<string> { return _engine!.rmbPendingBakes }
export function clearRmbCache(layerId: string): void { _engine!.clearRmbCache(layerId) }
export function flushFilterComputeDestroys(): void { _engine?.flushPendingDestroys() }
