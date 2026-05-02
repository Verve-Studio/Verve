import { createUniformBuffer, writeUniformBuffer, createReadbackBuffer, unpackRows } from '../../../utils'

import FILTER_CLOUDS_COMPUTE from './wgsl/filter-clouds.wgsl?raw'
export { FILTER_CLOUDS_COMPUTE }

export async function runClouds(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  pixels: Uint8Array,
  w: number,
  h: number,
  scale: number,
  opacity: number,
  colorMode: number,
  fgR: number,
  fgG: number,
  fgB: number,
  bgR: number,
  bgG: number,
  bgB: number,
  seed: number,
): Promise<Uint8Array> {
  // Build permutation table (Fisher-Yates, LCG matching C++)
  const perm = new Uint32Array(256)
  for (let i = 0; i < 256; i++) perm[i] = i
  let state = (seed ^ 0xDEADBEEF) >>> 0
  const lcg = (s: number) => (((1664525 * s) >>> 0) + 1013904223) >>> 0
  for (let i = 255; i > 0; i--) {
    state = lcg(state)
    const j = state % (i + 1)
    const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp
  }

  const permBuf = device.createBuffer({
    size: 256 * 4,  // 256 × u32
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(permBuf, 0, perm)

  const srcTex = device.createTexture({
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

  const smp = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })

  const outTex = device.createTexture({
    size: { width: w, height: h },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })

  // Pack params: 8 × u32 = 32 bytes
  const fgColor = (fgR | (fgG << 8) | (fgB << 16)) >>> 0
  const bgColor = (bgR | (bgG << 8) | (bgB << 16)) >>> 0
  const paramsData = new Uint32Array([scale, opacity, colorMode, fgColor, bgColor, w, h, 0])
  const paramsBuf  = createUniformBuffer(device, 32)
  writeUniformBuffer(device, paramsBuf, paramsData)

  const encoder  = device.createCommandEncoder()
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: smp },
      { binding: 2, resource: { buffer: paramsBuf } },
      { binding: 3, resource: { buffer: permBuf } },
    ],
  })

  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: outTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] })
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
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

  srcTex.destroy()
  outTex.destroy()
  paramsBuf.destroy()
  permBuf.destroy()
  readbuf.destroy()

  return result
}
