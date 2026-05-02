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
