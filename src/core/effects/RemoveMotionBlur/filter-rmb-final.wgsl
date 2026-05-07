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

struct RmbFinalParams {
  blendBack : f32,
  _pad0     : u32,
  _pad1     : u32,
  _pad2     : u32,
}

@group(0) @binding(0) var estTex           : texture_2d<f32>;  // rgba16float final estimate
@group(0) @binding(1) var inputTex         : texture_2d<f32>;  // original layer
@group(0) @binding(2) var<uniform> params  : RmbFinalParams;

@fragment
fn fs_rmb_final(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let est   = textureLoad(estTex,   coord, 0);
  let inp   = textureLoad(inputTex, coord, 0);
  let rgb   = clamp(mix(est.rgb, inp.rgb, params.blendBack), vec3f(0.0), vec3f(1.0));
  return vec4f(rgb, inp.a);
}
