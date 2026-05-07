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

struct ReduceNoiseParams {
  strength         : u32,
  preserveDetails  : u32,
  reduceColorNoise : u32,
  _pad0            : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : ReduceNoiseParams;

fn luma(c: vec3f) -> f32 {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

@fragment
fn fs_reduce_noise(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims   = textureDimensions(srcTex);
  let coord  = vec2i(i32(in.pos.x), i32(in.pos.y));

  let sigmaLuma   = f32(params.strength)         / 10.0  * 0.3;
  let sigmaChroma = f32(params.reduceColorNoise) / 100.0 * 0.4;
  let spatialR    = max(1u, u32(
    f32(10u - min(params.strength, 10u)) / 10.0
    * f32(params.preserveDetails) / 100.0
    * 7.0 + 1.0
  ));

  let inv2SigmaS2 = 1.0 / (2.0 * f32(spatialR) * f32(spatialR));

  let useLuma   = sigmaLuma   > 0.001;
  let useChroma = sigmaChroma > 0.001;
  let inv2SigmaL2 = select(0.0, 1.0 / (2.0 * sigmaLuma   * sigmaLuma),   useLuma);
  let inv2SigmaC2 = select(0.0, 1.0 / (2.0 * sigmaChroma * sigmaChroma), useChroma);

  let center     = textureLoad(srcTex, coord, 0);
  let centerLuma = luma(center.rgb);
  let r          = i32(spatialR);

  var weightSum = 0.0;
  var colorSum  = vec3f(0.0);

  for (var ky = -r; ky <= r; ky++) {
    for (var kx = -r; kx <= r; kx++) {
      let sx = clamp(coord.x + kx, 0, i32(dims.x) - 1);
      let sy = clamp(coord.y + ky, 0, i32(dims.y) - 1);
      let neighbor     = textureLoad(srcTex, vec2i(sx, sy), 0);
      let neighborLuma = luma(neighbor.rgb);

      let spatialDist2 = f32(kx * kx + ky * ky);
      let lumaDiff     = neighborLuma - centerLuma;
      let colorDiff    = neighbor.rgb - center.rgb;
      let colorDist2   = dot(colorDiff, colorDiff);

      let wS = exp(-spatialDist2 * inv2SigmaS2);
      let wL = select(1.0, exp(-lumaDiff * lumaDiff * inv2SigmaL2), useLuma);
      let wC = select(1.0, exp(-colorDist2          * inv2SigmaC2), useChroma);
      let w  = wS * wL * wC;

      colorSum  += neighbor.rgb * w;
      weightSum += w;
    }
  }

  let result = colorSum * (1.0 / max(weightSum, 0.0001));
  return vec4f(result, center.a);
}
