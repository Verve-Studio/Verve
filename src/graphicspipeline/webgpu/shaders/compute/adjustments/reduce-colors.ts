import { ADJ_VERTEX_SHADER, MASK_FLAGS_STRUCT, OKLAB_HELPERS } from './helpers'

export const RC_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
${MASK_FLAGS_STRUCT}
${OKLAB_HELPERS}

struct RCParams {
  paletteCount : u32,
  _pad         : vec3u,
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var smp      : sampler;
@group(0) @binding(2) var<uniform> params    : RCParams;
@group(0) @binding(3) var selMask  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;
@group(0) @binding(5) var<storage, read> palette : array<vec4f>;

@fragment
fn fs_reduce_colors(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);

  if (src.a < 0.0001 || params.paletteCount == 0u) {
    return src;
  }

  let srcLinear = srgb_to_linear(src.rgb);
  let srcLab    = linear_srgb_to_oklab(srcLinear);

  var bestIdx  : u32 = 0u;
  var bestDist : f32 = 1.0e30;
  for (var i: u32 = 0u; i < params.paletteCount; i++) {
    let pLab = palette[i].xyz;
    let d    = dot(srcLab - pLab, srcLab - pLab);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }

  let bestLinear = oklab_to_linear_srgb(palette[bestIdx].xyz);
  let bestSrgb   = linear_to_srgb(bestLinear);
  let adjusted   = vec4f(bestSrgb, src.a);

  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return mix(src, adjusted, mask);
}
` as const
