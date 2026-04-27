import { ADJ_VERTEX_SHADER } from '../adjustments/helpers'
import { createUniformBuffer, writeUniformBuffer, createReadbackBuffer, unpackRows } from '../../../utils'

export const FILTER_FILM_GRAIN_NOISE_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
struct FilmGrainNoiseParams {
  seed     : u32,
  imgWidth : u32,
  _pad0    : u32,
  _pad1    : u32,
}

@group(0) @binding(0) var<uniform> params : FilmGrainNoiseParams;

fn lcg_next(s: u32) -> u32 {
  return 1664525u * s + 1013904223u;
}

fn pcg_hash(v: u32) -> u32 {
  let word = v * 747796405u + 2891336453u;
  return ((word >> ((word >> 28u) + 4u)) ^ word) * 277803737u;
}

@fragment
fn fs_film_grain_noise(in: AdjVertOut) -> @location(0) vec4<f32> {
  let ix  = u32(in.pos.x);
  let iy  = u32(in.pos.y);
  let idx = iy * params.imgWidth + ix;
  var state = pcg_hash(params.seed ^ pcg_hash(idx));

  var sum = 0.0;
  for (var k = 0u; k < 4u; k++) {
    state = lcg_next(state);
    sum += f32(state >> 16u) / 32767.5;
  }
  let noise   = sum / 4.0 - 1.0;
  let encoded = clamp((noise + 1.0) * 0.5, 0.0, 1.0);
  return vec4f(encoded, encoded, encoded, encoded);
}
`

export const FILTER_FILM_GRAIN_COMBINE_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
struct FilmGrainCombineParams {
  intensity : u32,  // 1–200 (%)
  roughness : u32,  // 0–100
  _pad0     : u32,
  _pad1     : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var noiseTex        : texture_2d<f32>;
@group(0) @binding(3) var<uniform> params : FilmGrainCombineParams;

@fragment
fn fs_film_grain_combine(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord      = vec2i(i32(in.pos.x), i32(in.pos.y));
  let orig       = textureLoad(srcTex,   coord, 0);
  let noiseTexel = textureLoad(noiseTex, coord, 0);

  let noiseVal   = noiseTexel.r * 2.0 - 1.0;
  let intensityF = f32(params.intensity) / 100.0;
  let roughnessF = f32(params.roughness) / 100.0;

  let luma   = 0.299 * orig.r + 0.587 * orig.g + 0.114 * orig.b;
  let weight = (1.0 - roughnessF) * (1.0 - luma) + roughnessF * 1.0;

  let grainVal = noiseVal * (127.0 / 255.0) * weight * intensityF;

  let outRGB = clamp(orig.rgb + grainVal, vec3f(0.0), vec3f(1.0));
  return vec4f(outRGB, orig.a);
}
`

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
