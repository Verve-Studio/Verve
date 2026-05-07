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

@group(0) @binding(0) var inputTex   : texture_2d<f32>;  // original rgba8unorm layer
@group(0) @binding(1) var blurredTex : texture_2d<f32>;  // PSF(estimate) rgba16float

@fragment
fn fs_rmb_ratio(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let inp = textureLoad(inputTex,   coord, 0);
  let blr = textureLoad(blurredTex, coord, 0);
  let eps   = 1.0 / 255.0;
  // Clamp ratio to [0, 8] — prevents runaway amplification in very dark regions.
  let ratio = clamp(inp.rgb / max(blr.rgb, vec3f(eps)), vec3f(0.0), vec3f(8.0));
  // Use 1.0 for alpha so PSF(ratio) is 1.0 in the alpha channel everywhere.
  return vec4f(ratio, 1.0);
}
