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

struct SmartSharpenGaussParams {
  amount : u32,
  _pad0  : u32,
  _pad1  : u32,
  _pad2  : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var blurredTex      : texture_2d<f32>;
@group(0) @binding(3) var<uniform> params : SmartSharpenGaussParams;

@fragment
fn fs_smart_sharpen_gauss(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord   = vec2i(i32(in.pos.x), i32(in.pos.y));
  let orig    = textureLoad(srcTex,     coord, 0);
  let blurred = textureLoad(blurredTex, coord, 0);
  let scale   = f32(params.amount) / 100.0;
  let diff    = orig.rgb - blurred.rgb;
  let outRGB  = clamp(orig.rgb + scale * diff, vec3f(0.0), vec3f(1.0));
  return vec4f(outRGB, orig.a);
}
