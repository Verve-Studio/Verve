import { createUniformBuffer, writeUniformBuffer, createReadbackBuffer, unpackRows } from '../../../utils'
import { createTrackedTexture, destroyTrackedTexture } from '@/core/store/memoryStore'

import FILTER_SHARPEN_COMPUTE from './wgsl/filter-sharpen.wgsl?raw'
export { FILTER_SHARPEN_COMPUTE }

import FILTER_SHARPEN_MORE_COMPUTE from './wgsl/filter-sharpen-more.wgsl?raw'
export { FILTER_SHARPEN_MORE_COMPUTE }

import FILTER_UNSHARP_COMBINE_COMPUTE from './wgsl/filter-unsharp-combine.wgsl?raw'
export { FILTER_UNSHARP_COMBINE_COMPUTE }

export async function runSharpen(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  pixels: Uint8Array,
  w: number,
  h: number,
  _format: GPUTextureFormat = 'rgba8unorm',
): Promise<Uint8Array> {
  const smp = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })
  const srcTex = createTrackedTexture(device, { size: { width: w, height: h }, format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
  device.queue.writeTexture({ texture: srcTex }, pixels as Uint8Array<ArrayBuffer>, { bytesPerRow: w * 4, rowsPerImage: h }, { width: w, height: h })
  const outTex = createTrackedTexture(device, { size: { width: w, height: h }, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
  const encoder = device.createCommandEncoder()
  const bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: srcTex.createView() }, { binding: 1, resource: smp }] })
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: outTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] })
  pass.setPipeline(pipeline); pass.setBindGroup(0, bg); pass.draw(6); pass.end()
  const alignedBpr = Math.ceil(w * 4 / 256) * 256
  const readbuf = createReadbackBuffer(device, alignedBpr * h)
  encoder.copyTextureToBuffer({ texture: outTex }, { buffer: readbuf, bytesPerRow: alignedBpr, rowsPerImage: h }, { width: w, height: h })
  device.queue.submit([encoder.finish()])
  await readbuf.mapAsync(GPUMapMode.READ)
  const result = unpackRows(new Uint8Array(readbuf.getMappedRange()), w, h, alignedBpr)
  readbuf.unmap()
  destroyTrackedTexture(srcTex); destroyTrackedTexture(outTex); readbuf.destroy()
  return result
}

export async function runSharpenMore(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  pixels: Uint8Array,
  w: number,
  h: number,
  _format: GPUTextureFormat = 'rgba8unorm',
): Promise<Uint8Array> {
  const smp = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })
  const srcTex = createTrackedTexture(device, { size: { width: w, height: h }, format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
  device.queue.writeTexture({ texture: srcTex }, pixels as Uint8Array<ArrayBuffer>, { bytesPerRow: w * 4, rowsPerImage: h }, { width: w, height: h })
  const outTex = createTrackedTexture(device, { size: { width: w, height: h }, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
  const encoder = device.createCommandEncoder()
  const bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: srcTex.createView() }, { binding: 1, resource: smp }] })
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: outTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] })
  pass.setPipeline(pipeline); pass.setBindGroup(0, bg); pass.draw(6); pass.end()
  const alignedBpr = Math.ceil(w * 4 / 256) * 256
  const readbuf = createReadbackBuffer(device, alignedBpr * h)
  encoder.copyTextureToBuffer({ texture: outTex }, { buffer: readbuf, bytesPerRow: alignedBpr, rowsPerImage: h }, { width: w, height: h })
  device.queue.submit([encoder.finish()])
  await readbuf.mapAsync(GPUMapMode.READ)
  const result = unpackRows(new Uint8Array(readbuf.getMappedRange()), w, h, alignedBpr)
  readbuf.unmap()
  destroyTrackedTexture(srcTex); destroyTrackedTexture(outTex); readbuf.destroy()
  return result
}

export async function runUnsharpMask(
  device: GPUDevice,
  gaussianH: GPURenderPipeline,
  gaussianV: GPURenderPipeline,
  unsharpCombine: GPURenderPipeline,
  pixels: Uint8Array,
  w: number,
  h: number,
  amount: number,
  radius: number,
  threshold: number,
  format: GPUTextureFormat = 'rgba8unorm',
): Promise<Uint8Array> {
  const smp = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })
  const srcTex = createTrackedTexture(device, { size: { width: w, height: h }, format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
  device.queue.writeTexture({ texture: srcTex }, pixels as Uint8Array<ArrayBuffer>, { bytesPerRow: w * 4, rowsPerImage: h }, { width: w, height: h })
  const intermediateTex = createTrackedTexture(device, { size: { width: w, height: h }, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
  const blurredTex = createTrackedTexture(device, { size: { width: w, height: h }, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
  const outTex = createTrackedTexture(device, { size: { width: w, height: h }, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
  const gaussParamsBuf = createUniformBuffer(device, 16)
  writeUniformBuffer(device, gaussParamsBuf, new Uint32Array([radius, 0, 0, 0]))
  const combineParamsBuf = createUniformBuffer(device, 16)
  writeUniformBuffer(device, combineParamsBuf, new Uint32Array([amount, threshold, 0, 0]))
  const encoder = device.createCommandEncoder()
  const encRP = (pipeline: GPURenderPipeline, dst: GPUTexture, entries: GPUBindGroupEntry[]) => {
    const bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries })
    const p = encoder.beginRenderPass({ colorAttachments: [{ view: dst.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] })
    p.setPipeline(pipeline); p.setBindGroup(0, bg); p.draw(6); p.end()
  }
  encRP(gaussianH, intermediateTex, [{ binding: 0, resource: srcTex.createView() }, { binding: 1, resource: smp }, { binding: 2, resource: { buffer: gaussParamsBuf } }])
  encRP(gaussianV, blurredTex, [{ binding: 0, resource: intermediateTex.createView() }, { binding: 1, resource: smp }, { binding: 2, resource: { buffer: gaussParamsBuf } }])
  encRP(unsharpCombine, outTex, [{ binding: 0, resource: srcTex.createView() }, { binding: 1, resource: smp }, { binding: 2, resource: blurredTex.createView() }, { binding: 3, resource: { buffer: combineParamsBuf } }])
  const alignedBpr = Math.ceil(w * 4 / 256) * 256
  const readbuf = createReadbackBuffer(device, alignedBpr * h)
  encoder.copyTextureToBuffer({ texture: outTex }, { buffer: readbuf, bytesPerRow: alignedBpr, rowsPerImage: h }, { width: w, height: h })
  device.queue.submit([encoder.finish()])
  await readbuf.mapAsync(GPUMapMode.READ)
  const result = unpackRows(new Uint8Array(readbuf.getMappedRange()), w, h, alignedBpr)
  readbuf.unmap()
  destroyTrackedTexture(srcTex); destroyTrackedTexture(intermediateTex); destroyTrackedTexture(blurredTex); destroyTrackedTexture(outTex); gaussParamsBuf.destroy(); combineParamsBuf.destroy(); readbuf.destroy()
  return result
}
