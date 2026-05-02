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

struct RmbPsfParams {
  angleDeg : f32,
  distance : u32,
  _pad0    : u32,
  _pad1    : u32,
}

@group(0) @binding(0) var srcTex           : texture_2d<f32>;
@group(0) @binding(1) var<uniform> params  : RmbPsfParams;

fn sampleBilinearPsf(coord: vec2f, dims: vec2u) -> vec4f {
  let c  = clamp(coord, vec2f(0.0), vec2f(f32(dims.x) - 1.0, f32(dims.y) - 1.0));
  let x0 = i32(c.x); let y0 = i32(c.y);
  let x1 = min(x0 + 1, i32(dims.x) - 1);
  let y1 = min(y0 + 1, i32(dims.y) - 1);
  let fx = c.x - f32(x0); let fy = c.y - f32(y0);
  return mix(
    mix(textureLoad(srcTex, vec2i(x0, y0), 0), textureLoad(srcTex, vec2i(x1, y0), 0), fx),
    mix(textureLoad(srcTex, vec2i(x0, y1), 0), textureLoad(srcTex, vec2i(x1, y1), 0), fx),
    fy,
  );
}

@fragment
fn fs_rmb_psf(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims  = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let angle = params.angleDeg * 3.14159265358979 / 180.0;
  let stepX = cos(angle);
  let stepY = sin(angle);
  let dist  = params.distance;

  var sum = vec4f(0.0);
  for (var i = 0u; i < dist; i++) {
    let off = f32(i) - f32(dist - 1u) * 0.5;
    sum += sampleBilinearPsf(vec2f(f32(coord.x) + stepX * off, f32(coord.y) + stepY * off), dims);
  }
  return sum / f32(dist);
}
