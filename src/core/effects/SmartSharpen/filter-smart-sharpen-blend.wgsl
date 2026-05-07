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

struct SmartSharpenBlendParams {
  reduceNoise : u32,  // 0–100 (%)
  _pad0       : u32,
  _pad1       : u32,
  _pad2       : u32,
}

@group(0) @binding(0) var sharpenedTex    : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var smoothedTex     : texture_2d<f32>;
@group(0) @binding(3) var<uniform> params : SmartSharpenBlendParams;

@fragment
fn fs_smart_sharpen_blend(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord     = vec2i(i32(in.pos.x), i32(in.pos.y));
  let sharpened = textureLoad(sharpenedTex, coord, 0);
  let smoothed  = textureLoad(smoothedTex,  coord, 0);
  let blendFactor = (f32(params.reduceNoise) / 100.0) * 0.5;
  let outRGB = clamp(
    sharpened.rgb * (1.0 - blendFactor) + smoothed.rgb * blendFactor,
    vec3f(0.0), vec3f(1.0)
  );
  return vec4f(outRGB, sharpened.a);
}
