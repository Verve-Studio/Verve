import { ADJ_VERTEX_SHADER, MASK_FLAGS_STRUCT } from './helpers'

export const CURVES_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
${MASK_FLAGS_STRUCT}

@group(0) @binding(0) var srcTex    : texture_2d<f32>;
@group(0) @binding(1) var smp       : sampler;
@group(0) @binding(2) var selMask   : texture_2d<f32>;
@group(0) @binding(3) var<uniform> maskFlags  : MaskFlags;
@group(0) @binding(4) var lutSampler : sampler;
@group(0) @binding(5) var rgbLut    : texture_2d<f32>;
@group(0) @binding(6) var redLut    : texture_2d<f32>;
@group(0) @binding(7) var greenLut  : texture_2d<f32>;
@group(0) @binding(8) var blueLut   : texture_2d<f32>;

fn sampleLut(lut: texture_2d<f32>, channelValue: f32) -> f32 {
  return textureSampleLevel(lut, lutSampler, vec2f(clamp(channelValue, 0.0, 1.0), 0.5), 0.0).r;
}

@fragment
fn fs_curves(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);
  if (src.a < 0.0001) { return src; }

  let rgb1 = vec3f(
    sampleLut(rgbLut, src.r),
    sampleLut(rgbLut, src.g),
    sampleLut(rgbLut, src.b),
  );
  let adjusted = vec4f(
    sampleLut(redLut,   rgb1.r),
    sampleLut(greenLut, rgb1.g),
    sampleLut(blueLut,  rgb1.b),
    src.a,
  );
  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return mix(src, adjusted, mask);
}
` as const
