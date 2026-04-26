import { createUniformBuffer, writeUniformBuffer, createReadbackBuffer, unpackRows } from '../../../utils'

export const FILTER_MEDIAN_COMPUTE = /* wgsl */ `
struct MedianParams {
  radius : u32,
  _pad0  : u32,
  _pad1  : u32,
  _pad2  : u32,
}

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var dstTex : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params : MedianParams;

// Three 256-bin histograms (one per channel) in private memory.
// Replaces the old 441-element float sort array — uses ~3× less memory
// and enables O(256) median lookup instead of O(n²) insertion sort.
var<private> histR : array<u32, 256>;
var<private> histG : array<u32, 256>;
var<private> histB : array<u32, 256>;

// Walk histogram bins until cumulative count passes the midpoint — O(256).
fn histMedian(hist: ptr<private, array<u32, 256>>, mid: u32) -> f32 {
  var acc = 0u;
  for (var i = 0u; i < 256u; i++) {
    acc += (*hist)[i];
    if (acc > mid) { return f32(i) / 255.0; }
  }
  return 1.0;
}

@compute @workgroup_size(8, 8)
fn cs_median(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(srcTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }

  let r   = min(params.radius, 10u);
  let n   = (2u * r + 1u) * (2u * r + 1u);
  let mid = n / 2u;

  // Clear histograms.
  for (var i = 0u; i < 256u; i++) {
    histR[i] = 0u;
    histG[i] = 0u;
    histB[i] = 0u;
  }

  // Single sampling pass — load all three channels at once.
  // Previously the shader made 3 separate loops (1,323 texture reads at r=10);
  // this reduces to 441 reads.
  for (var ky = -i32(r); ky <= i32(r); ky++) {
    for (var kx = -i32(r); kx <= i32(r); kx++) {
      let sx = clamp(i32(id.x) + kx, 0, i32(dims.x) - 1);
      let sy = clamp(i32(id.y) + ky, 0, i32(dims.y) - 1);
      let c  = textureLoad(srcTex, vec2i(sx, sy), 0);
      histR[u32(c.r * 255.0 + 0.5)] += 1u;
      histG[u32(c.g * 255.0 + 0.5)] += 1u;
      histB[u32(c.b * 255.0 + 0.5)] += 1u;
    }
  }

  let orig = textureLoad(srcTex, vec2i(id.xy), 0);
  textureStore(dstTex, vec2i(id.xy), vec4f(
    histMedian(&histR, mid),
    histMedian(&histG, mid),
    histMedian(&histB, mid),
    orig.a,
  ));
}
` as const

export async function runMedian(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  pixels: Uint8Array,
  w: number,
  h: number,
  radius: number,
): Promise<Uint8Array> {
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
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  })

  const paramsData = new Uint32Array([radius, 0, 0, 0])
  const paramsBuf  = createUniformBuffer(device, 16)
  writeUniformBuffer(device, paramsBuf, paramsData)

  const encoder = device.createCommandEncoder()
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: outTex.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
    ],
  })

  const pass = encoder.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
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
