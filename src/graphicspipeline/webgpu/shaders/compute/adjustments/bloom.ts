import { ADJ_VERTEX_SHADER, MASK_FLAGS_STRUCT } from './helpers'

export const BLOOM_EXTRACT_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
${MASK_FLAGS_STRUCT}


struct BloomExtractParams {
  threshold : f32,
  _pad0     : f32,
  _pad1     : f32,
  _pad2     : f32,
}

@group(0) @binding(0) var srcTex     : texture_2d<f32>;
@group(0) @binding(1) var smp        : sampler;
@group(0) @binding(2) var<uniform> params    : BloomExtractParams;
@group(0) @binding(3) var selMask    : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

@fragment
fn fs_bloom_extract(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);

  let lum = dot(src.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let t   = params.threshold;
  let k   = 0.1;
  let w   = smoothstep(t - k, t + k, lum);
  let glow = vec4f(src.rgb * w, src.a * w);

  var out = glow;
  if (maskFlags.hasMask != 0u) {
    let mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    out = glow * mask;
  }
  return out;
}
` as const

export const BLOOM_DOWNSAMPLE_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}

struct BloomDownsampleParams {
  scale : u32,
  _pad0 : u32,
  _pad1 : u32,
  _pad2 : u32,
}

@group(0) @binding(0) var srcTex  : texture_2d<f32>;
@group(0) @binding(1) var smp     : sampler;
@group(0) @binding(2) var<uniform> params : BloomDownsampleParams;

@fragment
fn fs_bloom_downsample(in: AdjVertOut) -> @location(0) vec4<f32> {
  let srcDims = textureDimensions(srcTex);
  let dstX    = i32(in.pos.x);
  let dstY    = i32(in.pos.y);
  let scale   = i32(params.scale);
  var acc     = vec4f(0.0);
  let count   = f32(scale * scale);

  for (var dy: i32 = 0; dy < scale; dy++) {
    for (var dx: i32 = 0; dx < scale; dx++) {
      let sx = clamp(dstX * scale + dx, 0, i32(srcDims.x) - 1);
      let sy = clamp(dstY * scale + dy, 0, i32(srcDims.y) - 1);
      acc += textureLoad(srcTex, vec2i(sx, sy), 0);
    }
  }
  return acc / count;
}
` as const

export const BLOOM_BLUR_H_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}

struct BloomBlurParams {
  radius : u32,
  _pad0  : u32,
  _pad1  : u32,
  _pad2  : u32,
}

@group(0) @binding(0) var srcTex  : texture_2d<f32>;
@group(0) @binding(1) var smp     : sampler;
@group(0) @binding(2) var<uniform> params : BloomBlurParams;

@fragment
fn fs_bloom_blur_h(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims  = textureDimensions(srcTex);
  let r     = i32(params.radius);
  var acc   = vec4f(0.0);
  let count = f32(2 * r + 1);
  let x     = i32(in.pos.x);
  let y     = i32(in.pos.y);

  for (var dx: i32 = -r; dx <= r; dx++) {
    let sx = clamp(x + dx, 0, i32(dims.x) - 1);
    acc += textureLoad(srcTex, vec2i(sx, y), 0);
  }
  return acc / count;
}
` as const

export const BLOOM_BLUR_V_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}

struct BloomBlurParams {
  radius : u32,
  _pad0  : u32,
  _pad1  : u32,
  _pad2  : u32,
}

@group(0) @binding(0) var srcTex  : texture_2d<f32>;
@group(0) @binding(1) var smp     : sampler;
@group(0) @binding(2) var<uniform> params : BloomBlurParams;

@fragment
fn fs_bloom_blur_v(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims  = textureDimensions(srcTex);
  let r     = i32(params.radius);
  var acc   = vec4f(0.0);
  let count = f32(2 * r + 1);
  let x     = i32(in.pos.x);
  let y     = i32(in.pos.y);

  for (var dy: i32 = -r; dy <= r; dy++) {
    let sy = clamp(y + dy, 0, i32(dims.y) - 1);
    acc += textureLoad(srcTex, vec2i(x, sy), 0);
  }
  return acc / count;
}
` as const

export const BLOOM_COMPOSITE_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
${MASK_FLAGS_STRUCT}

struct BloomCompositeParams {
  strength : f32,
  _pad0    : f32,
  _pad1    : f32,
  _pad2    : f32,
}

@group(0) @binding(0) var srcTex       : texture_2d<f32>;
@group(0) @binding(1) var smp          : sampler;
@group(0) @binding(2) var glowTex      : texture_2d<f32>;
@group(0) @binding(3) var<uniform> params    : BloomCompositeParams;
@group(0) @binding(4) var selMask      : texture_2d<f32>;
@group(0) @binding(5) var<uniform> maskFlags : MaskFlags;

@fragment
fn fs_bloom_composite(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src  = textureSample(srcTex,  smp, in.uv);
  let glow = textureSample(glowTex, smp, in.uv);
  let g    = clamp(glow.rgb * params.strength, vec3f(0.0), vec3f(1.0));
  let out  = vec4f(1.0 - (1.0 - src.rgb) * (1.0 - g), src.a);

  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return mix(src, out, mask);
}
` as const
