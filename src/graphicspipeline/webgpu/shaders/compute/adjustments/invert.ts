import { ADJ_VERTEX_SHADER, MASK_FLAGS_STRUCT } from './helpers'

export const INVERT_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
${MASK_FLAGS_STRUCT}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var smp      : sampler;
@group(0) @binding(2) var selMask  : texture_2d<f32>;
@group(0) @binding(3) var<uniform> maskFlags : MaskFlags;

@fragment
fn fs_color_invert(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);
  if (src.a < 0.0001) { return src; }

  let adjusted = vec4f(1.0 - src.rgb, src.a);
  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return mix(src, adjusted, mask);
}
` as const
