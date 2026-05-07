struct AdjVertOut {
  @builtin(position) pos : vec4f,
  @location(0) uv        : vec2f,
}
@vertex
fn vs_adj(@builtin(vertex_index) vi: u32) -> AdjVertOut {
  let positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0), vec2f(1.0, -1.0), vec2f(1.0,  1.0),
  );
  let uvs = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
  );
  return AdjVertOut(vec4f(positions[vi], 0.0, 1.0), uvs[vi]);
}


struct MaskFlags {
  hasMask : u32,
  _pad    : vec3u,
}


// All vec4f members store source-channel multipliers + constant in
// percent space (i.e. 100 == 1.0×). The shader divides by 100 below.
//   .x = red multiplier
//   .y = green multiplier
//   .z = blue multiplier
//   .w = constant offset
struct ChannelMixerParams {
  red       : vec4f,
  green     : vec4f,
  blue      : vec4f,
  gray      : vec4f,
  flags     : vec4u, // x = monochrome (0 / 1)
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var smp      : sampler;
@group(0) @binding(2) var<uniform> params    : ChannelMixerParams;
@group(0) @binding(3) var selMask  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

fn mix_channel(coeffs: vec4f, src: vec3f) -> f32 {
  let rgb = coeffs.xyz / 100.0;
  let k   = coeffs.w / 100.0;
  return dot(rgb, src) + k;
}

@fragment
fn fs_channel_mixer(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);
  if (src.a < 0.0001) { return src; }

  var outRgb : vec3f;
  if (params.flags.x != 0u) {
    let g = mix_channel(params.gray, src.rgb);
    outRgb = vec3f(g, g, g);
  } else {
    outRgb = vec3f(
      mix_channel(params.red,   src.rgb),
      mix_channel(params.green, src.rgb),
      mix_channel(params.blue,  src.rgb),
    );
  }

  let adjusted = vec4f(clamp(outRgb, vec3f(0.0), vec3f(1.0)), src.a);

  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) {
    mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
  }
  return mix(src, adjusted, mask);
}
