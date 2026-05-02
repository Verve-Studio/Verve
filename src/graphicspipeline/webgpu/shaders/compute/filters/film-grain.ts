import { createUniformBuffer, writeUniformBuffer, createReadbackBuffer, unpackRows } from '../../../utils'

import FILTER_FILM_GRAIN_NOISE_COMPUTE from './wgsl/filter-film-grain-noise.wgsl?raw'
export { FILTER_FILM_GRAIN_NOISE_COMPUTE }

import FILTER_FILM_GRAIN_COMBINE_COMPUTE from './wgsl/filter-film-grain-combine.wgsl?raw'
export { FILTER_FILM_GRAIN_COMBINE_COMPUTE }

export async function runFilmGrain(
  device: GPUDevice,
  noisePipeline: GPURenderPipeline,
  combinePipeline: GPURenderPipeline,
  boxH: GPURenderPipeline,
  boxV: GPURenderPipeline,
  pixels: Uint8Array,
  w: number,
  h: number,
  grainSize: number,
  intensity: number,
  roughness: number,
  seed: number,
): Promise<Uint8Array> {
  const blurRadius = grainSize > 1 ? Math.min(5, Math.floor(grainSize / 10)) : 0
  const smp = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })

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

  const noiseTexA = device.createTexture({
    size: { width: w, height: h },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  })

  const noiseParamsBuf = createUniformBuffer(device, 16)
  writeUniformBuffer(device, noiseParamsBuf, new Uint32Array([seed >>> 0, w, 0, 0]))

  const encoder = device.createCommandEncoder()
  const encRP = (pipeline: GPURenderPipeline, dst: GPUTexture, entries: GPUBindGroupEntry[]) => {
    const bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries })
    const p = encoder.beginRenderPass({ colorAttachments: [{ view: dst.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] })
    p.setPipeline(pipeline); p.setBindGroup(0, bg); p.draw(6); p.end()
  }

  // Pass 1: Generate noise → noiseTexA
  encRP(noisePipeline, noiseTexA, [{ binding: 0, resource: { buffer: noiseParamsBuf } }])

  let finalNoiseTex: GPUTexture
  let noiseTexB: GPUTexture | null = null
  let boxParamsBuf: GPUBuffer | null = null
  let intermediateTex: GPUTexture | null = null

  if (blurRadius > 0) {
    noiseTexB = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    intermediateTex = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    boxParamsBuf = createUniformBuffer(device, 16)
    writeUniformBuffer(device, boxParamsBuf, new Uint32Array([blurRadius, 0, 0, 0]))

    encRP(boxH, intermediateTex, [{ binding: 0, resource: noiseTexA.createView() }, { binding: 1, resource: smp }, { binding: 2, resource: { buffer: boxParamsBuf } }])
    encRP(boxV, noiseTexB, [{ binding: 0, resource: intermediateTex.createView() }, { binding: 1, resource: smp }, { binding: 2, resource: { buffer: boxParamsBuf } }])

    finalNoiseTex = noiseTexB
  } else {
    finalNoiseTex = noiseTexA
  }

  const outTex = device.createTexture({
    size: { width: w, height: h },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })

  const combineParamsBuf = createUniformBuffer(device, 16)
  writeUniformBuffer(device, combineParamsBuf, new Uint32Array([intensity, roughness, 0, 0]))

  encRP(combinePipeline, outTex, [
    { binding: 0, resource: srcTex.createView() },
    { binding: 1, resource: smp },
    { binding: 2, resource: finalNoiseTex.createView() },
    { binding: 3, resource: { buffer: combineParamsBuf } },
  ])

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
  noiseTexA.destroy()
  noiseTexB?.destroy()
  intermediateTex?.destroy()
  outTex.destroy()
  noiseParamsBuf.destroy()
  boxParamsBuf?.destroy()
  combineParamsBuf.destroy()
  readbuf.destroy()

  return result
}
