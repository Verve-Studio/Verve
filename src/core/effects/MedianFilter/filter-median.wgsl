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

struct MedianParams {
  radius   : u32,
  // 1 for scene-linear targets (float docs).
  isLinear : u32,
  _pad1    : u32,
  _pad2    : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : MedianParams;

// One histogram, reused for each channel in turn (three live 256-entry
// arrays per invocation spilled registers).
//   bins   0..255 — [0, 1], sRGB-encoded for linear input so shadows get
//                   the same precision as an 8-bit document;
//   bins 256..319 — HDR values > 1, 8 bins per stop up to 2^8.
const NUM_BINS : u32 = 320u;
var<private> hist : array<u32, 320>;

fn lin_to_srgb(c: f32) -> f32 {
  return select(c * 12.92, 1.055 * pow(c, 1.0 / 2.4) - 0.055, c > 0.0031308);
}
fn srgb_to_lin(c: f32) -> f32 {
  return select(c / 12.92, pow((c + 0.055) / 1.055, 2.4), c > 0.04045);
}

fn binOf(v: f32, isLin: bool) -> u32 {
  if (!isLin) { return u32(clamp(v, 0.0, 1.0) * 255.0 + 0.5); }
  if (v <= 1.0) { return u32(lin_to_srgb(max(v, 0.0)) * 255.0 + 0.5); }
  return min(256u + u32(log2(v) * 8.0), NUM_BINS - 1u);
}

fn binValue(i: u32, isLin: bool) -> f32 {
  if (!isLin) { return f32(i) / 255.0; }
  if (i < 256u) { return srgb_to_lin(f32(i) / 255.0); }
  return exp2((f32(i - 256u) + 0.5) / 8.0);
}

@fragment
fn fs_median(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims  = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let isLin = params.isLinear != 0u;
  let nBins = select(256u, NUM_BINS, isLin);

  let r   = min(params.radius, 10u);
  let n   = (2u * r + 1u) * (2u * r + 1u);
  let mid = n / 2u;

  let orig = textureLoad(srcTex, coord, 0);
  var result = orig;

  for (var ch = 0u; ch < 3u; ch++) {
    for (var i = 0u; i < nBins; i++) { hist[i] = 0u; }

    for (var ky = -i32(r); ky <= i32(r); ky++) {
      for (var kx = -i32(r); kx <= i32(r); kx++) {
        let sx = clamp(coord.x + kx, 0, i32(dims.x) - 1);
        let sy = clamp(coord.y + ky, 0, i32(dims.y) - 1);
        let c  = textureLoad(srcTex, vec2i(sx, sy), 0);
        hist[binOf(c[ch], isLin)] += 1u;
      }
    }

    // Walk bins until the cumulative count passes the midpoint.
    var acc = 0u;
    var med = binValue(nBins - 1u, isLin);
    for (var i = 0u; i < nBins; i++) {
      acc += hist[i];
      if (acc > mid) { med = binValue(i, isLin); break; }
    }
    result[ch] = med;
  }

  return result;
}
