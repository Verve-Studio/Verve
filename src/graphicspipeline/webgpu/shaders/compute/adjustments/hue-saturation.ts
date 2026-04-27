import { ADJ_VERTEX_SHADER, MASK_FLAGS_STRUCT, HSL_HELPERS } from './helpers'

export const HS_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
${MASK_FLAGS_STRUCT}
${HSL_HELPERS}

struct HSParams {
  hue        : f32,
  saturation : f32,
  lightness  : f32,
  _pad       : f32,
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var smp      : sampler;
@group(0) @binding(2) var<uniform> params    : HSParams;
@group(0) @binding(3) var selMask  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

@fragment
fn fs_hue_saturation(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);
  if (src.a < 0.0001) { return src; }

  var hsl = rgb2hsl(src.rgb);
  hsl.x = hsl.x + params.hue / 360.0;
  hsl.x = hsl.x - floor(hsl.x);
  hsl.y = clamp(hsl.y + params.saturation / 100.0, 0.0, 1.0);
  hsl.z = clamp(hsl.z + params.lightness  / 100.0, 0.0, 1.0);

  let adjusted = vec4f(hsl2rgb(hsl), src.a);
  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return mix(src, adjusted, mask);
}
` as const
