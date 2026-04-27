import { ADJ_VERTEX_SHADER } from '../adjustments/helpers'
import { createUniformBuffer, writeUniformBuffer, createReadbackBuffer, unpackRows } from '../../../utils'

export const FILTER_SMART_SHARPEN_GAUSS_COMBINE_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
struct SmartSharpenGaussParams {
  amount : u32,
  _pad0  : u32,
  _pad1  : u32,
  _pad2  : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var blurredTex      : texture_2d<f32>;
@group(0) @binding(3) var<uniform> params : SmartSharpenGaussParams;

@fragment
fn fs_smart_sharpen_gauss(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord   = vec2i(i32(in.pos.x), i32(in.pos.y));
  let orig    = textureLoad(srcTex,     coord, 0);
  let blurred = textureLoad(blurredTex, coord, 0);
  let scale   = f32(params.amount) / 100.0;
  let diff    = orig.rgb - blurred.rgb;
  let outRGB  = clamp(orig.rgb + scale * diff, vec3f(0.0), vec3f(1.0));
  return vec4f(outRGB, orig.a);
}
`

export const FILTER_SMART_SHARPEN_LENS_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
struct SmartSharpenLensParams {
  amount : u32,
  _pad0  : u32,
  _pad1  : u32,
  _pad2  : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : SmartSharpenLensParams;

@fragment
fn fs_smart_sharpen_lens(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims  = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let s     = (f32(params.amount) / 100.0) * 0.5;

  var colorSum = vec3f(0.0);
  for (var ky = -1; ky <= 1; ky++) {
    for (var kx = -1; kx <= 1; kx++) {
      let sx = clamp(coord.x + kx, 0, i32(dims.x) - 1);
      let sy = clamp(coord.y + ky, 0, i32(dims.y) - 1);
      let samp = textureLoad(srcTex, vec2i(sx, sy), 0).rgb;
      let isCenter = select(0.0, 1.0, kx == 0 && ky == 0);
      let k = isCenter * (1.0 + 8.0 * s) + (1.0 - isCenter) * (-s);
      colorSum += samp * k;
    }
  }

  let orig = textureLoad(srcTex, coord, 0);
  return vec4f(clamp(colorSum, vec3f(0.0), vec3f(1.0)), orig.a);
}
`

export const FILTER_SMART_SHARPEN_BLEND_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
struct SmartSharpenBlendParams {
  reduceNoise : u32,  // 0–100 (%)
  _pad0       : u32,
  _pad1       : u32,
  _pad2       : u32,
}

@group(0) @binding(0) var sharpenedTex    : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var smoothedTex     : texture_2d<f32>;
@group(0) @binding(3) var<uniform> params : SmartSharpenBlendParams;

@fragment
fn fs_smart_sharpen_blend(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord     = vec2i(i32(in.pos.x), i32(in.pos.y));
  let sharpened = textureLoad(sharpenedTex, coord, 0);
  let smoothed  = textureLoad(smoothedTex,  coord, 0);
  let blendFactor = (f32(params.reduceNoise) / 100.0) * 0.5;
  let outRGB = clamp(
    sharpened.rgb * (1.0 - blendFactor) + smoothed.rgb * blendFactor,
    vec3f(0.0), vec3f(1.0)
  );
  return vec4f(outRGB, sharpened.a);
}
`

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

  const sharpenedTex = device.createTexture({
    size: { width: w, height: h },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
  })

  const intermediateTex = device.createTexture({
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

    const blurredTex = device.createTexture({
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

    const smoothedTex = device.createTexture({
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

    const outTex = device.createTexture({
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

  srcTex.destroy()
  sharpenedTex.destroy()
  intermediateTex.destroy()
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
