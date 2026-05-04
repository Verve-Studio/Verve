import { createUniformBuffer, writeUniformBuffer, createReadbackBuffer, unpackRows } from '../../../utils'
import { createTrackedTexture, destroyTrackedTexture } from '@/core/store/memoryStore'

import FILTER_BOX_H_COMPUTE from './wgsl/filter-box-h.wgsl?raw'
export { FILTER_BOX_H_COMPUTE }

import FILTER_BOX_V_COMPUTE from './wgsl/filter-box-v.wgsl?raw'
export { FILTER_BOX_V_COMPUTE }

export async function runBoxBlur(
  device: GPUDevice,
  hPipeline: GPURenderPipeline,
  vPipeline: GPURenderPipeline,
  pixels: Uint8Array,
  w: number,
  h: number,
  radius: number,
  format: GPUTextureFormat = 'rgba8unorm',
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

  const intermediateTex = createTrackedTexture(device, {
    size: { width: w, height: h },
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  })

  const outTex = createTrackedTexture(device, {
    size: { width: w, height: h },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })

  const paramsData = new Uint32Array([radius, 0, 0, 0])
  const paramsBuf  = createUniformBuffer(device, 16)
  writeUniformBuffer(device, paramsBuf, paramsData)

  const encoder = device.createCommandEncoder()

  const hBg = device.createBindGroup({
    layout: hPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: smp },
      { binding: 2, resource: { buffer: paramsBuf } },
    ],
  })
  const hPass = encoder.beginRenderPass({
    colorAttachments: [{ view: intermediateTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
  })
  hPass.setPipeline(hPipeline)
  hPass.setBindGroup(0, hBg)
  hPass.draw(6)
  hPass.end()

  const vBg = device.createBindGroup({
    layout: vPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: intermediateTex.createView() },
      { binding: 1, resource: smp },
      { binding: 2, resource: { buffer: paramsBuf } },
    ],
  })
  const vPass = encoder.beginRenderPass({
    colorAttachments: [{ view: outTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
  })
  vPass.setPipeline(vPipeline)
  vPass.setBindGroup(0, vBg)
  vPass.draw(6)
  vPass.end()

  const alignedBpr = Math.ceil(w * 4 / 256) * 256
  const readbuf    = createReadbackBuffer(device, alignedBpr * h)
  encoder.copyTextureToBuffer(
    { texture: outTex },
    { buffer: readbuf, bytesPerRow: alignedBpr, rowsPerImage: h },
    { width: w, height: h },
  )

  device.queue.submit([encoder.finish()])

  await readbuf.mapAsync(GPUMapMode.READ)
  const result = unpackRows(new Uint8Array(readbuf.getMappedRange()), w, h, alignedBpr)
  readbuf.unmap()

  destroyTrackedTexture(srcTex)
  destroyTrackedTexture(intermediateTex)
  destroyTrackedTexture(outTex)
  paramsBuf.destroy()
  readbuf.destroy()

  return result
}
