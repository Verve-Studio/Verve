import { ADJ_VERTEX_SHADER, MASK_FLAGS_STRUCT } from './helpers'

export const BC_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
${MASK_FLAGS_STRUCT}

struct BCParams {
  brightness : f32,
  contrast   : f32,
  _pad       : vec2f,
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var smp      : sampler;
@group(0) @binding(2) var<uniform> params    : BCParams;
@group(0) @binding(3) var selMask  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

@fragment
fn fs_brightness_contrast(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);
  if (src.a < 0.0001) { return src; }

  var rgb = src.rgb;
  let b = params.brightness / 100.0;
  rgb = clamp(rgb + b, vec3f(0.0), vec3f(1.0));
  let cFactor = (params.contrast + 100.0) / 100.0;
  rgb = clamp((rgb - 0.5) * cFactor + 0.5, vec3f(0.0), vec3f(1.0));

  let adjusted = vec4f(rgb, src.a);
  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return mix(src, adjusted, mask);
}
` as const
