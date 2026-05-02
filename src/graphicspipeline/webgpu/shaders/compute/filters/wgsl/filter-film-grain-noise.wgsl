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

struct FilmGrainNoiseParams {
  seed     : u32,
  imgWidth : u32,
  _pad0    : u32,
  _pad1    : u32,
}

@group(0) @binding(0) var<uniform> params : FilmGrainNoiseParams;

fn lcg_next(s: u32) -> u32 {
  return 1664525u * s + 1013904223u;
}

fn pcg_hash(v: u32) -> u32 {
  let word = v * 747796405u + 2891336453u;
  return ((word >> ((word >> 28u) + 4u)) ^ word) * 277803737u;
}

@fragment
fn fs_film_grain_noise(in: AdjVertOut) -> @location(0) vec4<f32> {
  let ix  = u32(in.pos.x);
  let iy  = u32(in.pos.y);
  let idx = iy * params.imgWidth + ix;
  var state = pcg_hash(params.seed ^ pcg_hash(idx));

  var sum = 0.0;
  for (var k = 0u; k < 4u; k++) {
    state = lcg_next(state);
    sum += f32(state >> 16u) / 32767.5;
  }
  let noise   = sum / 4.0 - 1.0;
  let encoded = clamp((noise + 1.0) * 0.5, 0.0, 1.0);
  return vec4f(encoded, encoded, encoded, encoded);
}
