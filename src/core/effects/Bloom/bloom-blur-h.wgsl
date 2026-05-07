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


struct BloomBlurParams {
  radius : u32,
  _pad0  : u32,
  _pad1  : u32,
  _pad2  : u32,
}

@group(0) @binding(0) var srcTex  : texture_2d<f32>;
@group(0) @binding(1) var smp     : sampler;
@group(0) @binding(2) var<uniform> params : BloomBlurParams;

@fragment
fn fs_bloom_blur_h(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims  = textureDimensions(srcTex);
  let r     = i32(params.radius);
  var acc   = vec4f(0.0);
  let count = f32(2 * r + 1);
  let x     = i32(in.pos.x);
  let y     = i32(in.pos.y);

  for (var dx: i32 = -r; dx <= r; dx++) {
    let sx = clamp(x + dx, 0, i32(dims.x) - 1);
    acc += textureLoad(srcTex, vec2i(sx, y), 0);
  }
  return acc / count;
}
