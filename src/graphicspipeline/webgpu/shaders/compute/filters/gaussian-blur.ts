import { ADJ_VERTEX_SHADER } from '../adjustments/helpers'
import { createUniformBuffer, writeUniformBuffer, createReadbackBuffer, unpackRows } from '../../../utils'

export const FILTER_GAUSSIAN_H_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
struct GaussianBlurParams {
  radius : u32,
  _pad0  : u32,
  _pad1  : u32,
  _pad2  : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : GaussianBlurParams;

@fragment
fn fs_gaussian_h(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims     = textureDimensions(srcTex);
  let coord    = vec2i(i32(in.pos.x), i32(in.pos.y));
  let sigma    = max(f32(params.radius), 1.0) / 3.0;
  let inv2sig2 = 1.0 / (2.0 * sigma * sigma);
  let maxR     = i32(params.radius);

  var weightSum = 0.0;
  var colorSum  = vec4f(0.0);

  for (var x = -maxR; x <= maxR; x++) {
    let w  = exp(-f32(x * x) * inv2sig2);
    let sx = clamp(coord.x + x, 0, i32(dims.x) - 1);
    colorSum  += textureLoad(srcTex, vec2i(sx, coord.y), 0) * w;
    weightSum += w;
  }

  return colorSum * (1.0 / weightSum);
}
` as const

export const FILTER_GAUSSIAN_V_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
struct GaussianBlurParams {
  radius : u32,
  _pad0  : u32,
  _pad1  : u32,
  _pad2  : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : GaussianBlurParams;

@fragment
fn fs_gaussian_v(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims     = textureDimensions(srcTex);
  let coord    = vec2i(i32(in.pos.x), i32(in.pos.y));
  let sigma    = max(f32(params.radius), 1.0) / 3.0;
  let inv2sig2 = 1.0 / (2.0 * sigma * sigma);
  let maxR     = i32(params.radius);

  var weightSum = 0.0;
  var colorSum  = vec4f(0.0);

  for (var y = -maxR; y <= maxR; y++) {
    let w  = exp(-f32(y * y) * inv2sig2);
    let sy = clamp(coord.y + y, 0, i32(dims.y) - 1);
    colorSum  += textureLoad(srcTex, vec2i(coord.x, sy), 0) * w;
    weightSum += w;
  }

  return colorSum * (1.0 / weightSum);
}
` as const

export async function runGaussianBlur(
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

  const intermediateTex = device.createTexture({
    size: { width: w, height: h },
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  })

  const outTex = device.createTexture({
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

  srcTex.destroy()
  intermediateTex.destroy()
  outTex.destroy()
  paramsBuf.destroy()
  readbuf.destroy()

  return result
}
