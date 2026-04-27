import { ADJ_VERTEX_SHADER } from '../adjustments/helpers'
import { createUniformBuffer, writeUniformBuffer, createReadbackBuffer, unpackRows } from '../../../utils'

export const FILTER_ADD_NOISE_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
struct AddNoiseParams {
  amount        : u32,  // 1–400 (%)
  distribution  : u32,  // 0=uniform, 1=gaussian
  monochromatic : u32,  // 0|1
  seed          : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : AddNoiseParams;

fn lcg_next(s: u32) -> u32 {
  return 1664525u * s + 1013904223u;
}

fn pcg_hash(v: u32) -> u32 {
  let word = v * 747796405u + 2891336453u;
  return ((word >> ((word >> 28u) + 4u)) ^ word) * 277803737u;
}

fn pixel_rng_seed(seed: u32, idx: u32) -> u32 {
  return pcg_hash(seed ^ pcg_hash(idx));
}

fn sample_uniform(state: ptr<function, u32>, range: u32, maxDelta: u32) -> i32 {
  *state = lcg_next(*state);
  return i32(*state % range) - i32(maxDelta);
}

fn sample_gaussian(state: ptr<function, u32>, range: u32, maxDelta: u32) -> i32 {
  var sum: i32 = 0;
  for (var k = 0u; k < 4u; k++) {
    *state = lcg_next(*state);
    sum += i32(*state % range);
  }
  return sum / 4 - i32(maxDelta);
}

@fragment
fn fs_add_noise(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims  = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));

  let maxDelta = params.amount * 127u / 100u;
  let orig = textureLoad(srcTex, coord, 0);
  if (maxDelta == 0u) {
    return orig;
  }
  let range = 2u * maxDelta + 1u;
  let idx   = u32(coord.y) * dims.x + u32(coord.x);
  var state = pixel_rng_seed(params.seed, idx);

  var dR: i32; var dG: i32; var dB: i32;

  if (params.monochromatic != 0u) {
    let d = select(
      sample_gaussian(&state, range, maxDelta),
      sample_uniform(&state, range, maxDelta),
      params.distribution == 0u
    );
    dR = d; dG = d; dB = d;
  } else {
    dR = select(sample_gaussian(&state, range, maxDelta), sample_uniform(&state, range, maxDelta), params.distribution == 0u);
    dG = select(sample_gaussian(&state, range, maxDelta), sample_uniform(&state, range, maxDelta), params.distribution == 0u);
    dB = select(sample_gaussian(&state, range, maxDelta), sample_uniform(&state, range, maxDelta), params.distribution == 0u);
  }

  let outR = clamp(orig.r + f32(dR) / 255.0, 0.0, 1.0);
  let outG = clamp(orig.g + f32(dG) / 255.0, 0.0, 1.0);
  let outB = clamp(orig.b + f32(dB) / 255.0, 0.0, 1.0);

  return vec4f(outR, outG, outB, orig.a);
}
` as const

export async function runAddNoise(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  pixels: Uint8Array,
  w: number,
  h: number,
  amount: number,
  distribution: number,
  monochromatic: number,
  seed: number,
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

  const paramsData = new Uint32Array([amount, distribution, monochromatic, seed >>> 0])
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
  const result = unpackRows(new Uint8Array(readbuf.getMappedRange()), w, h, alignedBpr)
  readbuf.unmap()

  srcTex.destroy()
  outTex.destroy()
  paramsBuf.destroy()
  readbuf.destroy()

  return result
}
