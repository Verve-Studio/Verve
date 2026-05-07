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

struct BilateralParams {
  radius       : u32,
  _pad0        : u32,
  sigmaSpatial : f32,
  sigmaColor   : f32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : BilateralParams;

@fragment
fn fs_bilateral(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims   = textureDimensions(srcTex);
  let coord  = vec2i(i32(in.pos.x), i32(in.pos.y));
  let center = textureLoad(srcTex, coord, 0);
  let r      = i32(params.radius);

  let inv2SigmaS2 = 1.0 / (2.0 * params.sigmaSpatial * params.sigmaSpatial);
  let inv2SigmaC2 = 1.0 / (2.0 * params.sigmaColor   * params.sigmaColor);

  var weightSum = 0.0;
  var colorSum  = vec3f(0.0);

  for (var ky = -r; ky <= r; ky++) {
    for (var kx = -r; kx <= r; kx++) {
      let sx = clamp(coord.x + kx, 0, i32(dims.x) - 1);
      let sy = clamp(coord.y + ky, 0, i32(dims.y) - 1);
      let neighbor = textureLoad(srcTex, vec2i(sx, sy), 0);

      let spatialDist2 = f32(kx * kx + ky * ky);
      let colorDiff    = neighbor.rgb - center.rgb;
      let colorDist2   = dot(colorDiff, colorDiff);

      let w = exp(-spatialDist2 * inv2SigmaS2) * exp(-colorDist2 * inv2SigmaC2);

      colorSum  += neighbor.rgb * w;
      weightSum += w;
    }
  }

  let result = colorSum * (1.0 / weightSum);
  return vec4f(result, center.a);
}
