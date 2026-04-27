import { ADJ_VERTEX_SHADER, MASK_FLAGS_STRUCT } from './helpers'

export const TEMP_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
${MASK_FLAGS_STRUCT}

struct TempParams {
  temperature : f32,
  tint        : f32,
  _pad        : vec2f,
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var smp      : sampler;
@group(0) @binding(2) var<uniform> params    : TempParams;
@group(0) @binding(3) var selMask  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

@fragment
fn fs_color_temperature(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);
  if (src.a < 0.0001) { return src; }

  let t = params.temperature / 100.0;
  let n = params.tint         / 100.0;
  let dR =  t * 0.2 + n * 0.1;
  let dG = -n * 0.2;
  let dB = -t * 0.2 + n * 0.1;

  let adjusted = clamp(src.rgb + vec3f(dR, dG, dB), vec3f(0.0), vec3f(1.0));
  let result = vec4f(adjusted, src.a);
  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return mix(src, result, mask);
}
` as const
