import { ADJ_VERTEX_SHADER } from '../adjustments/helpers'
import { createUniformBuffer, writeUniformBuffer, createReadbackBuffer, unpackRows } from '../../../utils'

export const FILTER_SHARPEN_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var smp    : sampler;

const kernel = array<f32, 9>(
   0.0, -1.0,  0.0,
  -1.0,  5.0, -1.0,
   0.0, -1.0,  0.0,
);

@fragment
fn fs_sharpen(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  var colorSum = vec4f(0.0);
  for (var ky = -1; ky <= 1; ky++) {
    for (var kx = -1; kx <= 1; kx++) {
      let sx = clamp(coord.x + kx, 0, i32(dims.x) - 1);
      let sy = clamp(coord.y + ky, 0, i32(dims.y) - 1);
      let k  = kernel[(ky + 1) * 3 + (kx + 1)];
      colorSum += textureLoad(srcTex, vec2i(sx, sy), 0) * k;
    }
  }
  let orig = textureLoad(srcTex, coord, 0);
  return vec4f(clamp(colorSum.rgb, vec3f(0.0), vec3f(1.0)), orig.a);
}
`

export const FILTER_SHARPEN_MORE_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var smp    : sampler;

const kernel = array<f32, 9>(
  -1.0, -1.0, -1.0,
  -1.0,  9.0, -1.0,
  -1.0, -1.0, -1.0,
);

@fragment
fn fs_sharpen_more(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  var colorSum = vec4f(0.0);
  for (var ky = -1; ky <= 1; ky++) {
    for (var kx = -1; kx <= 1; kx++) {
      let sx = clamp(coord.x + kx, 0, i32(dims.x) - 1);
      let sy = clamp(coord.y + ky, 0, i32(dims.y) - 1);
      let k  = kernel[(ky + 1) * 3 + (kx + 1)];
      colorSum += textureLoad(srcTex, vec2i(sx, sy), 0) * k;
    }
  }
  let orig = textureLoad(srcTex, coord, 0);
  return vec4f(clamp(colorSum.rgb, vec3f(0.0), vec3f(1.0)), orig.a);
}
`

export const FILTER_UNSHARP_COMBINE_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
struct UnsharpParams {
  amount    : u32,
  threshold : u32,
  _pad0     : u32,
  _pad1     : u32,
}

@group(0) @binding(0) var origTex             : texture_2d<f32>;
@group(0) @binding(1) var smp                 : sampler;
@group(0) @binding(2) var blurredTex          : texture_2d<f32>;
@group(0) @binding(3) var<uniform> params     : UnsharpParams;

@fragment
fn fs_unsharp_combine(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord   = vec2i(i32(in.pos.x), i32(in.pos.y));
  let orig    = textureLoad(origTex,    coord, 0);
  let blurred = textureLoad(blurredTex, coord, 0);

  let scale = f32(params.amount) / 100.0;
  let thr   = f32(params.threshold) / 255.0;

  let dR = orig.r - blurred.r;
  let dG = orig.g - blurred.g;
  let dB = orig.b - blurred.b;

  let lumaDiff = abs(0.299 * dR + 0.587 * dG + 0.114 * dB);

  if (lumaDiff > thr) {
    return vec4f(
      clamp(orig.r + scale * dR, 0.0, 1.0),
      clamp(orig.g + scale * dG, 0.0, 1.0),
      clamp(orig.b + scale * dB, 0.0, 1.0),
      orig.a,
    );
  }
  return vec4f(orig.rgb, orig.a);
}
` as const

export async function runSharpen(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  pixels: Uint8Array,
  w: number,
  h: number,
  format: GPUTextureFormat = 'rgba8unorm',
): Promise<Uint8Array> {
  const smp = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })
  const srcTex = device.createTexture({ size: { width: w, height: h }, format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
  device.queue.writeTexture({ texture: srcTex }, pixels as Uint8Array<ArrayBuffer>, { bytesPerRow: w * 4, rowsPerImage: h }, { width: w, height: h })
  const outTex = device.createTexture({ size: { width: w, height: h }, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
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
  srcTex.destroy(); outTex.destroy(); readbuf.destroy()
  return result
}

export async function runSharpenMore(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  pixels: Uint8Array,
  w: number,
  h: number,
  format: GPUTextureFormat = 'rgba8unorm',
): Promise<Uint8Array> {
  const smp = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })
  const srcTex = device.createTexture({ size: { width: w, height: h }, format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
  device.queue.writeTexture({ texture: srcTex }, pixels as Uint8Array<ArrayBuffer>, { bytesPerRow: w * 4, rowsPerImage: h }, { width: w, height: h })
  const outTex = device.createTexture({ size: { width: w, height: h }, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
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
  srcTex.destroy(); outTex.destroy(); readbuf.destroy()
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
  const srcTex = device.createTexture({ size: { width: w, height: h }, format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
  device.queue.writeTexture({ texture: srcTex }, pixels as Uint8Array<ArrayBuffer>, { bytesPerRow: w * 4, rowsPerImage: h }, { width: w, height: h })
  const intermediateTex = device.createTexture({ size: { width: w, height: h }, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
  const blurredTex = device.createTexture({ size: { width: w, height: h }, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
  const outTex = device.createTexture({ size: { width: w, height: h }, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
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
  srcTex.destroy(); intermediateTex.destroy(); blurredTex.destroy(); outTex.destroy(); gaussParamsBuf.destroy(); combineParamsBuf.destroy(); readbuf.destroy()
  return result
}
