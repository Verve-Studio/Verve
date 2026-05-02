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

struct MotionBlurParams {
  angleDeg : f32,
  distance : u32,
  _pad0    : u32,
  _pad1    : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : MotionBlurParams;

fn sampleBilinear(coord: vec2f, dims: vec2u) -> vec4f {
  let clamped = clamp(coord, vec2f(0.0), vec2f(f32(dims.x) - 1.0, f32(dims.y) - 1.0));
  let x0 = i32(clamped.x);
  let y0 = i32(clamped.y);
  let x1 = min(x0 + 1, i32(dims.x) - 1);
  let y1 = min(y0 + 1, i32(dims.y) - 1);
  let fx = clamped.x - f32(x0);
  let fy = clamped.y - f32(y0);
  let p00 = textureLoad(srcTex, vec2i(x0, y0), 0);
  let p10 = textureLoad(srcTex, vec2i(x1, y0), 0);
  let p01 = textureLoad(srcTex, vec2i(x0, y1), 0);
  let p11 = textureLoad(srcTex, vec2i(x1, y1), 0);
  return mix(mix(p00, p10, fx), mix(p01, p11, fx), fy);
}

@fragment
fn fs_motion_blur(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims  = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let px    = f32(coord.x);
  let py    = f32(coord.y);
  let angle = params.angleDeg * 3.14159265358979323846 / 180.0;
  let stepX = cos(angle);
  let stepY = sin(angle);
  let dist  = params.distance;

  var colorSum = vec4f(0.0);
  for (var i = 0u; i < dist; i++) {
    let offset = f32(i) - f32(dist - 1u) * 0.5;
    colorSum += sampleBilinear(vec2f(px + stepX * offset, py + stepY * offset), dims);
  }

  return colorSum * (1.0 / f32(dist));
}
