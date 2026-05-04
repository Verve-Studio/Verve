import { createUniformBuffer, writeUniformBuffer, createReadbackBuffer, unpackRows } from '../../../utils'
import { createTrackedTexture, destroyTrackedTexture } from '@/core/store/memoryStore'

import FILTER_SMART_SHARPEN_GAUSS_COMBINE_COMPUTE from './wgsl/filter-smart-sharpen-gauss-combine.wgsl?raw'
export { FILTER_SMART_SHARPEN_GAUSS_COMBINE_COMPUTE }

import FILTER_SMART_SHARPEN_LENS_COMPUTE from './wgsl/filter-smart-sharpen-lens.wgsl?raw'
export { FILTER_SMART_SHARPEN_LENS_COMPUTE }

import FILTER_SMART_SHARPEN_BLEND_COMPUTE from './wgsl/filter-smart-sharpen-blend.wgsl?raw'
export { FILTER_SMART_SHARPEN_BLEND_COMPUTE }

export async function runSmartSharpen(
  device: GPUDevice,
  gaussianH: GPURenderPipeline,
  gaussianV: GPURenderPipeline,
  boxH: GPURenderPipeline,
  boxV: GPURenderPipeline,
  smartSharpenGaussCombine: GPURenderPipeline,
  smartSharpenLens: GPURenderPipeline,
  smartSharpenBlend: GPURenderPipeline,
  pixels: Uint8Array,
  w: number,
  h: number,
  amount: number,
  radius: number,
  reduceNoise: number,
  remove: number,
): Promise<Uint8Array> {
  const smp = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })

  const srcTex = createTrackedTexture(device, {
    size: { width: w, height: h },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  device.queue.writeTexture(
    { texture: srcTex },
    pixels as Uint8Array<ArrayBuffer>,
    { bytesPerRow: w * 4, rowsPerImage: h },
    { width: w, height: h },
  )

  const sharpenedTex = createTrackedTexture(device, {
    size: { width: w, height: h },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
  })

  const intermediateTex = createTrackedTexture(device, {
    size: { width: w, height: h },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  })

  const encoder = device.createCommandEncoder()
  const encRP = (pipeline: GPURenderPipeline, dst: GPUTexture, entries: GPUBindGroupEntry[]) => {
    const bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries })
    const p = encoder.beginRenderPass({ colorAttachments: [{ view: dst.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] })
    p.setPipeline(pipeline); p.setBindGroup(0, bg); p.draw(6); p.end()
  }

  let _blurredTex: GPUTexture | null = null
  let _gaussParamsBuf: GPUBuffer | null = null
  let _combineParamsBuf: GPUBuffer | null = null
  let _lensParamsBuf: GPUBuffer | null = null

  if (remove === 0) {
    const gaussParamsBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, gaussParamsBuf, new Uint32Array([radius, 0, 0, 0]))
    _gaussParamsBuf = gaussParamsBuf

    const blurredTex = createTrackedTexture(device, {
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    _blurredTex = blurredTex

    encRP(gaussianH, intermediateTex, [{ binding: 0, resource: srcTex.createView() }, { binding: 1, resource: smp }, { binding: 2, resource: { buffer: gaussParamsBuf } }])
    encRP(gaussianV, blurredTex, [{ binding: 0, resource: intermediateTex.createView() }, { binding: 1, resource: smp }, { binding: 2, resource: { buffer: gaussParamsBuf } }])

    const combineParamsBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, combineParamsBuf, new Uint32Array([amount, 0, 0, 0]))
    _combineParamsBuf = combineParamsBuf

    encRP(smartSharpenGaussCombine, sharpenedTex, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: smp },
      { binding: 2, resource: blurredTex.createView() },
      { binding: 3, resource: { buffer: combineParamsBuf } },
    ])
  } else {
    const lensParamsBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, lensParamsBuf, new Uint32Array([amount, 0, 0, 0]))
    _lensParamsBuf = lensParamsBuf

    encRP(smartSharpenLens, sharpenedTex, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: smp },
      { binding: 2, resource: { buffer: lensParamsBuf } },
    ])
  }

  let finalTex: GPUTexture
  let _outTex: GPUTexture | null = null
  let _smoothedTex: GPUTexture | null = null
  let _noiseParamsBuf: GPUBuffer | null = null
  let _boxParamsBuf: GPUBuffer | null = null

  if (reduceNoise > 0) {
    const boxParamsBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, boxParamsBuf, new Uint32Array([1, 0, 0, 0]))
    _boxParamsBuf = boxParamsBuf

    const smoothedTex = createTrackedTexture(device, {
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    _smoothedTex = smoothedTex

    encRP(boxH, intermediateTex, [{ binding: 0, resource: sharpenedTex.createView() }, { binding: 1, resource: smp }, { binding: 2, resource: { buffer: boxParamsBuf } }])
    encRP(boxV, smoothedTex, [{ binding: 0, resource: intermediateTex.createView() }, { binding: 1, resource: smp }, { binding: 2, resource: { buffer: boxParamsBuf } }])

    const noiseParamsBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, noiseParamsBuf, new Uint32Array([reduceNoise, 0, 0, 0]))
    _noiseParamsBuf = noiseParamsBuf

    const outTex = createTrackedTexture(device, {
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
    _outTex = outTex

    encRP(smartSharpenBlend, outTex, [
      { binding: 0, resource: sharpenedTex.createView() },
      { binding: 1, resource: smp },
      { binding: 2, resource: smoothedTex.createView() },
      { binding: 3, resource: { buffer: noiseParamsBuf } },
    ])

    finalTex = outTex
  } else {
    finalTex = sharpenedTex
  }

  const alignedBpr = Math.ceil(w * 4 / 256) * 256
  const readbuf    = createReadbackBuffer(device, alignedBpr * h)
  encoder.copyTextureToBuffer(
    { texture: finalTex },
    { buffer: readbuf, bytesPerRow: alignedBpr, rowsPerImage: h },
    { width: w, height: h },
  )

  device.queue.submit([encoder.finish()])

  await readbuf.mapAsync(GPUMapMode.READ)
  const result = unpackRows(new Uint8Array(readbuf.getMappedRange()), w, h, alignedBpr)
  readbuf.unmap()

  destroyTrackedTexture(srcTex)
  destroyTrackedTexture(sharpenedTex)
  destroyTrackedTexture(intermediateTex)
  _blurredTex?.destroy()
  _gaussParamsBuf?.destroy()
  _combineParamsBuf?.destroy()
  _lensParamsBuf?.destroy()
  _smoothedTex?.destroy()
  _outTex?.destroy()
  _noiseParamsBuf?.destroy()
  _boxParamsBuf?.destroy()
  readbuf.destroy()

  return result
}
