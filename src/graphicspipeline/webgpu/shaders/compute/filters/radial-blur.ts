import { createUniformBuffer, writeUniformBuffer, createReadbackBuffer, unpackRows } from '../../../utils'
import { createTrackedTexture, destroyTrackedTexture } from '@/core/store/memoryStore'

import FILTER_RADIAL_BLUR_COMPUTE from './wgsl/filter-radial-blur.wgsl?raw'
export { FILTER_RADIAL_BLUR_COMPUTE }

export async function runRadialBlur(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  pixels: Uint8Array,
  w: number,
  h: number,
  mode: number,
  amount: number,
  centerX: number,
  centerY: number,
  quality: number,
  _format: GPUTextureFormat = 'rgba8unorm',
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

  const outTex = createTrackedTexture(device, {
    size: { width: w, height: h },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })

  const buf = new ArrayBuffer(32)
  const dv  = new DataView(buf)
  dv.setUint32(0,  mode,    true)
  dv.setUint32(4,  amount,  true)
  dv.setUint32(8,  quality, true)
  dv.setUint32(12, 0,       true)
  dv.setFloat32(16, centerX, true)
  dv.setFloat32(20, centerY, true)
  dv.setFloat32(24, 0,       true)
  dv.setFloat32(28, 0,       true)
  const paramsBuf = createUniformBuffer(device, 32)
  writeUniformBuffer(device, paramsBuf, buf)

  const encoder = device.createCommandEncoder()

  const bg = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: smp },
      { binding: 2, resource: { buffer: paramsBuf } },
    ],
  })
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: outTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
  })
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bg)
  pass.draw(6)
  pass.end()

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
  destroyTrackedTexture(outTex)
  paramsBuf.destroy()
  readbuf.destroy()

  return result
}
