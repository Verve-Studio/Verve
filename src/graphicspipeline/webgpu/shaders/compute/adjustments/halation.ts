import { ADJ_VERTEX_SHADER, MASK_FLAGS_STRUCT } from './helpers'

export const HALATION_EXTRACT_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
${MASK_FLAGS_STRUCT}

struct HalationExtractParams {
  threshold : f32,
  _pad0     : f32,
  _pad1     : f32,
  _pad2     : f32,
}

@group(0) @binding(0) var srcTex              : texture_2d<f32>;
@group(0) @binding(1) var smp                 : sampler;
@group(0) @binding(2) var<uniform> params     : HalationExtractParams;
@group(0) @binding(3) var selMask             : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags  : MaskFlags;

@fragment
fn fs_halation_extract(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src   = textureSample(srcTex, smp, in.uv);

  let lum = dot(src.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let t   = params.threshold;
  let k   = 0.1;
  let w   = smoothstep(t - k, t + k, lum);

  let tint = vec3f(1.0, 0.22, 0.05);
  let glow  = vec4f(src.rgb * tint * w, src.a * w);

  var out = glow;
  if (maskFlags.hasMask != 0u) {
    let mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    out = glow * mask;
  }
  return out;
}
` as const
