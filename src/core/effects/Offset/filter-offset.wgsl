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

struct OffsetParams {
  offsetX : i32,
  offsetY : i32,
  _pad0   : i32,
  _pad1   : i32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(2) var<uniform> params : OffsetParams;

@fragment
fn fs_offset(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dimsU = textureDimensions(srcTex);
  let dims  = vec2i(i32(dimsU.x), i32(dimsU.y));
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));

  // Inverse mapping: an output pixel at `coord` shows whatever lived at
  // `coord - offset` in the source. The double-mod handles negative offsets
  // correctly — WGSL's `%` operator on signed ints follows truncated
  // division, so a single `%` can yield a negative remainder.
  let raw   = coord - vec2i(params.offsetX, params.offsetY);
  let src_x = ((raw.x % dims.x) + dims.x) % dims.x;
  let src_y = ((raw.y % dims.y) + dims.y) % dims.y;

  return textureLoad(srcTex, vec2i(src_x, src_y), 0);
}
