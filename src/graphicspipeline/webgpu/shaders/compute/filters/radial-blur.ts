import { ADJ_VERTEX_SHADER } from '../adjustments/helpers'
import { createUniformBuffer, writeUniformBuffer, createReadbackBuffer, unpackRows } from '../../../utils'

export const FILTER_RADIAL_BLUR_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
struct RadialBlurParams {
  mode    : u32,
  amount  : u32,
  quality : u32,
  _pad0   : u32,
  centerX : f32,
  centerY : f32,
  _pad1   : f32,
  _pad2   : f32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : RadialBlurParams;

fn sampleBilinear(coord: vec2f, dims: vec2u) -> vec4f {
  let clamped = clamp(coord, vec2f(0.0), vec2f(f32(dims.x) - 1.0, f32(dims.y) - 1.0));
  let x0 = i32(clamped.x);
  let y0 = i32(clamped.y);
  let x1 = min(x0 + 1, i32(dims.x) - 1);
  let y1 = min(y0 + 1, i32(dims.y) - 1);
  let fx = clamped.x - f32(x0);
  let fy = clamped.y - f32(y0);
  let p00 = textureLoad(srcTex, vec2i(x0, y0), 0);
  let p10 = textureLoad(srcTex, vec2i(x1, y0), 0);
  let p01 = textureLoad(srcTex, vec2i(x0, y1), 0);
  let p11 = textureLoad(srcTex, vec2i(x1, y1), 0);
  return mix(mix(p00, p10, fx), mix(p01, p11, fx), fy);
}

@fragment
fn fs_radial_blur(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));

  let px = f32(coord.x);
  let py = f32(coord.y);
  let cx = params.centerX * f32(dims.x - 1u);
  let cy = params.centerY * f32(dims.y - 1u);
  let dx = px - cx;
  let dy = py - cy;

  let numSamples = select(select(8u, 16u, params.quality == 1u), 32u, params.quality == 2u);
  let invN = 1.0 / f32(numSamples - 1u);

  var colorSum = vec4f(0.0);

  if (params.mode == 0u) {
    let dist = sqrt(dx * dx + dy * dy);
    if (dist < 0.5) {
      return textureLoad(srcTex, coord, 0);
    }
    let spinAngle = f32(params.amount) * 3.14159265358979323846 / 1800.0;
    let baseAngle = atan2(dy, dx);
    for (var s = 0u; s < numSamples; s++) {
      let t = f32(s) * invN;
      let theta = baseAngle - spinAngle * 0.5 + t * spinAngle;
      colorSum += sampleBilinear(vec2f(cx + dist * cos(theta), cy + dist * sin(theta)), dims);
    }
  } else {
    if (abs(dx) < 0.5 && abs(dy) < 0.5) {
      return textureLoad(srcTex, coord, 0);
    }
    let scale = f32(params.amount) * 0.005;
    for (var s = 0u; s < numSamples; s++) {
      let t = f32(s) * invN;
      let factor = 1.0 - t * scale;
      colorSum += sampleBilinear(vec2f(cx + dx * factor, cy + dy * factor), dims);
    }
  }

  return colorSum * (1.0 / f32(numSamples));
}
` as const

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

  srcTex.destroy()
  outTex.destroy()
  paramsBuf.destroy()
  readbuf.destroy()

  return result
}
