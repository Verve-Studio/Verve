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

@group(0) @binding(0) var estTex  : texture_2d<f32>;  // current estimate
@group(0) @binding(1) var corrTex : texture_2d<f32>;  // PSF(ratio), range [0, 8]

@fragment
fn fs_rmb_update(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord   = vec2i(i32(in.pos.x), i32(in.pos.y));
  let est     = textureLoad(estTex,  coord, 0);
  let corr    = textureLoad(corrTex, coord, 0);
  let updated = clamp(est.rgb * corr.rgb, vec3f(0.0), vec3f(1.0));
  return vec4f(updated, est.a);
}
