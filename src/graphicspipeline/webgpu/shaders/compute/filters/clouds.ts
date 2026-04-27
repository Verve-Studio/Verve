import { ADJ_VERTEX_SHADER } from '../adjustments/helpers'
import { createUniformBuffer, writeUniformBuffer, createReadbackBuffer, unpackRows } from '../../../utils'

export const FILTER_CLOUDS_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
struct CloudsParams {
  scale     : u32,
  opacity   : u32,
  colorMode : u32,
  fgColor   : u32,
  bgColor   : u32,
  imgWidth  : u32,
  imgHeight : u32,
  _pad      : u32,
}

@group(0) @binding(0) var srcTex                   : texture_2d<f32>;
@group(0) @binding(1) var smp                      : sampler;
@group(0) @binding(2) var<uniform> params          : CloudsParams;
@group(0) @binding(3) var<storage, read> perm      : array<u32>;  // 256 entries, each is u8 value

const GX = array<f32, 8>(  1.0, -1.0,  0.0,  0.0,  0.7071, -0.7071,  0.7071, -0.7071 );
const GY = array<f32, 8>(  0.0,  0.0,  1.0, -1.0,  0.7071,  0.7071, -0.7071, -0.7071 );

fn fade(t: f32) -> f32 {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn hsample(ix: i32, iy: i32) -> u32 {
  let a = perm[ix & 255];
  let b = (a + u32(iy & 255)) & 255u;
  return perm[b] & 7u;
}

fn perlin(fx: f32, fy: f32) -> f32 {
  let xi = i32(floor(fx));
  let yi = i32(floor(fy));
  let rx0 = fx - f32(xi);
  let ry0 = fy - f32(yi);
  let u = fade(rx0);
  let v = fade(ry0);

  let h00 = hsample(xi,     yi    );
  let h10 = hsample(xi + 1, yi    );
  let h01 = hsample(xi,     yi + 1);
  let h11 = hsample(xi + 1, yi + 1);

  let d00 = GX[h00] * rx0         + GY[h00] * ry0;
  let d10 = GX[h10] * (rx0 - 1.0) + GY[h10] * ry0;
  let d01 = GX[h01] * rx0         + GY[h01] * (ry0 - 1.0);
  let d11 = GX[h11] * (rx0 - 1.0) + GY[h11] * (ry0 - 1.0);

  let ab = d00 + u * (d10 - d00);
  let cd = d01 + u * (d11 - d01);
  return ab + v * (cd - ab);
}

@fragment
fn fs_clouds(in: AdjVertOut) -> @location(0) vec4<f32> {
  let ix = u32(in.pos.x);
  let iy = u32(in.pos.y);

  let featureSize = max(f32(params.scale) / 100.0 * f32(min(params.imgWidth, params.imgHeight)), 1.0);
  let baseFreq    = 256.0 / featureSize;

  var total  = 0.0;
  var maxAmp = 0.0;
  var freq   = baseFreq;
  var amp    = 1.0;
  for (var oct = 0; oct < 6; oct++) {
    total  += perlin(f32(ix) * freq, f32(iy) * freq) * amp;
    maxAmp += amp;
    amp    *= 0.5;
    freq   *= 2.0;
  }

  let t = clamp(total / maxAmp * 1.4 + 0.5, 0.0, 1.0);

  var cloudR: f32; var cloudG: f32; var cloudB: f32;
  if (params.colorMode == 0u) {
    cloudR = t; cloudG = t; cloudB = t;
  } else {
    let fgR = f32((params.fgColor)        & 0xFFu) / 255.0;
    let fgG = f32((params.fgColor >>  8u) & 0xFFu) / 255.0;
    let fgB = f32((params.fgColor >> 16u) & 0xFFu) / 255.0;
    let bgR = f32((params.bgColor)        & 0xFFu) / 255.0;
    let bgG = f32((params.bgColor >>  8u) & 0xFFu) / 255.0;
    let bgB = f32((params.bgColor >> 16u) & 0xFFu) / 255.0;
    cloudR = bgR + (fgR - bgR) * t;
    cloudG = bgG + (fgG - bgG) * t;
    cloudB = bgB + (fgB - bgB) * t;
  }

  let orig     = textureLoad(srcTex, vec2i(i32(ix), i32(iy)), 0);
  let opacityF = f32(params.opacity) / 100.0;

  let outR = clamp(orig.r + (cloudR - orig.r) * opacityF, 0.0, 1.0);
  let outG = clamp(orig.g + (cloudG - orig.g) * opacityF, 0.0, 1.0);
  let outB = clamp(orig.b + (cloudB - orig.b) * opacityF, 0.0, 1.0);

  return vec4f(outR, outG, outB, orig.a);
}
`

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
