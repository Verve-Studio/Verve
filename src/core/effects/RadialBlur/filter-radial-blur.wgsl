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

struct RadialBlurParams {
  mode    : u32,
  amount  : u32,
  quality : u32,
  _pad0   : u32,
  centerX : f32,
  centerY : f32,
  _pad1   : f32,
  _pad2   : f32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : RadialBlurParams;

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
fn fs_radial_blur(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));

  let px = f32(coord.x);
  let py = f32(coord.y);
  let cx = params.centerX * f32(dims.x - 1u);
  let cy = params.centerY * f32(dims.y - 1u);
  let dx = px - cx;
  let dy = py - cy;

  let numSamples = select(select(8u, 16u, params.quality == 1u), 32u, params.quality == 2u);
  let invN = 1.0 / f32(numSamples - 1u);

  var colorSum = vec4f(0.0);

  if (params.mode == 0u) {
    let dist = sqrt(dx * dx + dy * dy);
    if (dist < 0.5) {
      return textureLoad(srcTex, coord, 0);
    }
    let spinAngle = f32(params.amount) * 3.14159265358979323846 / 1800.0;
    let baseAngle = atan2(dy, dx);
    for (var s = 0u; s < numSamples; s++) {
      let t = f32(s) * invN;
      let theta = baseAngle - spinAngle * 0.5 + t * spinAngle;
      colorSum += sampleBilinear(vec2f(cx + dist * cos(theta), cy + dist * sin(theta)), dims);
    }
  } else {
    if (abs(dx) < 0.5 && abs(dy) < 0.5) {
      return textureLoad(srcTex, coord, 0);
    }
    let scale = f32(params.amount) * 0.005;
    for (var s = 0u; s < numSamples; s++) {
      let t = f32(s) * invN;
      let factor = 1.0 - t * scale;
      colorSum += sampleBilinear(vec2f(cx + dx * factor, cy + dy * factor), dims);
    }
  }

  return colorSum * (1.0 / f32(numSamples));
}
