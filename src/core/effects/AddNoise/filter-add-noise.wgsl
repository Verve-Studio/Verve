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

struct AddNoiseParams {
  amount        : u32,  // 1–400 (%)
  distribution  : u32,  // 0=uniform, 1=gaussian
  monochromatic : u32,  // 0|1
  seed          : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : AddNoiseParams;

fn lcg_next(s: u32) -> u32 {
  return 1664525u * s + 1013904223u;
}

fn pcg_hash(v: u32) -> u32 {
  let word = v * 747796405u + 2891336453u;
  return ((word >> ((word >> 28u) + 4u)) ^ word) * 277803737u;
}

fn pixel_rng_seed(seed: u32, idx: u32) -> u32 {
  return pcg_hash(seed ^ pcg_hash(idx));
}

fn sample_uniform(state: ptr<function, u32>, range: u32, maxDelta: u32) -> i32 {
  *state = lcg_next(*state);
  return i32(*state % range) - i32(maxDelta);
}

fn sample_gaussian(state: ptr<function, u32>, range: u32, maxDelta: u32) -> i32 {
  var sum: i32 = 0;
  for (var k = 0u; k < 4u; k++) {
    *state = lcg_next(*state);
    sum += i32(*state % range);
  }
  return sum / 4 - i32(maxDelta);
}

@fragment
fn fs_add_noise(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims  = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));

  let maxDelta = params.amount * 127u / 100u;
  let orig = textureLoad(srcTex, coord, 0);
  if (maxDelta == 0u) {
    return orig;
  }
  let range = 2u * maxDelta + 1u;
  let idx   = u32(coord.y) * dims.x + u32(coord.x);
  var state = pixel_rng_seed(params.seed, idx);

  var dR: i32; var dG: i32; var dB: i32;

  if (params.monochromatic != 0u) {
    let d = select(
      sample_gaussian(&state, range, maxDelta),
      sample_uniform(&state, range, maxDelta),
      params.distribution == 0u
    );
    dR = d; dG = d; dB = d;
  } else {
    dR = select(sample_gaussian(&state, range, maxDelta), sample_uniform(&state, range, maxDelta), params.distribution == 0u);
    dG = select(sample_gaussian(&state, range, maxDelta), sample_uniform(&state, range, maxDelta), params.distribution == 0u);
    dB = select(sample_gaussian(&state, range, maxDelta), sample_uniform(&state, range, maxDelta), params.distribution == 0u);
  }

  let outR = clamp(orig.r + f32(dR) / 255.0, 0.0, 1.0);
  let outG = clamp(orig.g + f32(dG) / 255.0, 0.0, 1.0);
  let outB = clamp(orig.b + f32(dB) / 255.0, 0.0, 1.0);

  return vec4f(outR, outG, outB, orig.a);
}
