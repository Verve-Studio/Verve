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

struct GaussianBlurParams {
  radius : u32,
  _pad0  : u32,
  _pad1  : u32,
  _pad2  : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : GaussianBlurParams;

@fragment
fn fs_gaussian_h(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims     = textureDimensions(srcTex);
  let coord    = vec2i(i32(in.pos.x), i32(in.pos.y));
  let sigma    = max(f32(params.radius), 1.0) / 3.0;
  let inv2sig2 = 1.0 / (2.0 * sigma * sigma);
  let maxR     = i32(params.radius);

  var weightSum = 0.0;
  var colorSum  = vec4f(0.0);

  for (var x = -maxR; x <= maxR; x++) {
    let w  = exp(-f32(x * x) * inv2sig2);
    let sx = clamp(coord.x + x, 0, i32(dims.x) - 1);
    colorSum  += textureLoad(srcTex, vec2i(sx, coord.y), 0) * w;
    weightSum += w;
  }

  return colorSum * (1.0 / weightSum);
}
