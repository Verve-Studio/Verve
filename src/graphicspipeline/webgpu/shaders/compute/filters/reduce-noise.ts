import { ADJ_VERTEX_SHADER } from '../adjustments/helpers'
import { createUniformBuffer, writeUniformBuffer, createReadbackBuffer, unpackRows } from '../../../utils'

export const FILTER_REDUCE_NOISE_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
struct ReduceNoiseParams {
  strength         : u32,
  preserveDetails  : u32,
  reduceColorNoise : u32,
  _pad0            : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : ReduceNoiseParams;

fn luma(c: vec3f) -> f32 {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

@fragment
fn fs_reduce_noise(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims   = textureDimensions(srcTex);
  let coord  = vec2i(i32(in.pos.x), i32(in.pos.y));

  let sigmaLuma   = f32(params.strength)         / 10.0  * 0.3;
  let sigmaChroma = f32(params.reduceColorNoise) / 100.0 * 0.4;
  let spatialR    = max(1u, u32(
    f32(10u - min(params.strength, 10u)) / 10.0
    * f32(params.preserveDetails) / 100.0
    * 7.0 + 1.0
  ));

  let inv2SigmaS2 = 1.0 / (2.0 * f32(spatialR) * f32(spatialR));

  let useLuma   = sigmaLuma   > 0.001;
  let useChroma = sigmaChroma > 0.001;
  let inv2SigmaL2 = select(0.0, 1.0 / (2.0 * sigmaLuma   * sigmaLuma),   useLuma);
  let inv2SigmaC2 = select(0.0, 1.0 / (2.0 * sigmaChroma * sigmaChroma), useChroma);

  let center     = textureLoad(srcTex, coord, 0);
  let centerLuma = luma(center.rgb);
  let r          = i32(spatialR);

  var weightSum = 0.0;
  var colorSum  = vec3f(0.0);

  for (var ky = -r; ky <= r; ky++) {
    for (var kx = -r; kx <= r; kx++) {
      let sx = clamp(coord.x + kx, 0, i32(dims.x) - 1);
      let sy = clamp(coord.y + ky, 0, i32(dims.y) - 1);
      let neighbor     = textureLoad(srcTex, vec2i(sx, sy), 0);
      let neighborLuma = luma(neighbor.rgb);

      let spatialDist2 = f32(kx * kx + ky * ky);
      let lumaDiff     = neighborLuma - centerLuma;
      let colorDiff    = neighbor.rgb - center.rgb;
      let colorDist2   = dot(colorDiff, colorDiff);

      let wS = exp(-spatialDist2 * inv2SigmaS2);
      let wL = select(1.0, exp(-lumaDiff * lumaDiff * inv2SigmaL2), useLuma);
      let wC = select(1.0, exp(-colorDist2          * inv2SigmaC2), useChroma);
      let w  = wS * wL * wC;

      colorSum  += neighbor.rgb * w;
      weightSum += w;
    }
  }

  let result = colorSum * (1.0 / max(weightSum, 0.0001));
  return vec4f(result, center.a);
}
` as const

export async function runReduceNoise(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  pixels: Uint8Array,
  w: number,
  h: number,
  strength: number,
  preserveDetails: number,
  reduceColorNoise: number,
  sharpenDetails: number,
  unsharpMaskFn: (pixels: Uint8Array, w: number, h: number, amount: number, radius: number, threshold: number) => Promise<Uint8Array>,
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

  const outTex = device.createTexture({
    size: { width: w, height: h },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })

  const paramsData = new Uint32Array([strength, preserveDetails, reduceColorNoise, 0])
  const paramsBuf  = createUniformBuffer(device, 16)
  writeUniformBuffer(device, paramsBuf, paramsData)

  const encoder   = device.createCommandEncoder()
  const bindGroup = device.createBindGroup({
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
  let result = unpackRows(new Uint8Array(readbuf.getMappedRange()), w, h, alignedBpr)
  readbuf.unmap()

  srcTex.destroy()
  outTex.destroy()
  paramsBuf.destroy()
  readbuf.destroy()

  if (sharpenDetails > 0) {
    const sharpAmount = Math.round(sharpenDetails * 1.5)
    result = await unsharpMaskFn(result, w, h, sharpAmount, 1, 0)
  }

  return result
}
