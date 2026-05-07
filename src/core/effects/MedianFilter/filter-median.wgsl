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
  radius : u32,
  _pad0  : u32,
  _pad1  : u32,
  _pad2  : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : MedianParams;

// Three 256-bin histograms (one per channel) in private memory.
// Replaces the old 441-element float sort array — uses ~3× less memory
// and enables O(256) median lookup instead of O(n²) insertion sort.
var<private> histR : array<u32, 256>;
var<private> histG : array<u32, 256>;
var<private> histB : array<u32, 256>;

// Walk histogram bins until cumulative count passes the midpoint — O(256).
fn histMedian(hist: ptr<private, array<u32, 256>>, mid: u32) -> f32 {
  var acc = 0u;
  for (var i = 0u; i < 256u; i++) {
    acc += (*hist)[i];
    if (acc > mid) { return f32(i) / 255.0; }
  }
  return 1.0;
}

@fragment
fn fs_median(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims  = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));

  let r   = min(params.radius, 10u);
  let n   = (2u * r + 1u) * (2u * r + 1u);
  let mid = n / 2u;

  for (var i = 0u; i < 256u; i++) {
    histR[i] = 0u;
    histG[i] = 0u;
    histB[i] = 0u;
  }

  for (var ky = -i32(r); ky <= i32(r); ky++) {
    for (var kx = -i32(r); kx <= i32(r); kx++) {
      let sx = clamp(coord.x + kx, 0, i32(dims.x) - 1);
      let sy = clamp(coord.y + ky, 0, i32(dims.y) - 1);
      let c  = textureLoad(srcTex, vec2i(sx, sy), 0);
      histR[u32(c.r * 255.0 + 0.5)] += 1u;
      histG[u32(c.g * 255.0 + 0.5)] += 1u;
      histB[u32(c.b * 255.0 + 0.5)] += 1u;
    }
  }

  let orig = textureLoad(srcTex, coord, 0);
  return vec4f(
    histMedian(&histR, mid),
    histMedian(&histG, mid),
    histMedian(&histB, mid),
    orig.a,
  );
}
