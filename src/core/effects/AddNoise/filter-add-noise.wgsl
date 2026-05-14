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
  // 0 = sRGB-encoded input (rgba8 doc), 1 = scene-linear (rgba32f). The
  // noise delta is `/ 255` — calibrated for perceptual byte values; on
  // scene-linear floats the same numerical delta represents a much larger
  // perceptual jump (e.g. 0.2 linear ≈ 50% display brightness), which is
  // why noise looks markedly stronger in f32 docs. Run the add in
  // perceptual space and decode back to scene-linear so the visible noise
  // amplitude matches what the user dialled in on rgba8.
  inputIsLinear : u32,
  _pad0         : u32,
  _pad1         : u32,
  _pad2         : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : AddNoiseParams;

fn srgbEncodeF(c: f32) -> f32 {
  let x = max(c, 0.0);
  return select(1.055 * pow(x, 1.0 / 2.4) - 0.055, x * 12.92, x <= 0.0031308);
}
fn srgbDecodeF(c: f32) -> f32 {
  let x = max(c, 0.0);
  return select(pow((x + 0.055) / 1.055, 2.4), x / 12.92, x <= 0.04045);
}
fn srgbEncode(rgb: vec3f) -> vec3f { return vec3f(srgbEncodeF(rgb.r), srgbEncodeF(rgb.g), srgbEncodeF(rgb.b)); }
fn srgbDecode(rgb: vec3f) -> vec3f { return vec3f(srgbDecodeF(rgb.r), srgbDecodeF(rgb.g), srgbDecodeF(rgb.b)); }

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

// Continuous float uniform in `[-1, +1)`. The previous integer-mod approach
// quantised the noise to 1/255 steps — exactly the rgba8 byte grid, fine
// there but a hard ceiling on the precision the rgba32f buffer can actually
// represent. The float path uses the full mantissa.
fn rand01(state: ptr<function, u32>) -> f32 {
  *state = lcg_next(*state);
  return f32(*state) * (1.0 / 4294967296.0);
}
fn sample_uniform_f(state: ptr<function, u32>) -> f32 {
  return rand01(state) * 2.0 - 1.0;
}
// Approx Gaussian via central-limit theorem: sum of four uniforms in `[0,1)`,
// centred at 2 then scaled to `[-1, +1]` peak amplitude. Same distribution
// shape as the legacy integer path, but continuous.
fn sample_gaussian_f(state: ptr<function, u32>) -> f32 {
  var sum: f32 = 0.0;
  for (var k = 0u; k < 4u; k++) {
    sum += rand01(state);
  }
  return (sum - 2.0) * 0.5;
}

@fragment
fn fs_add_noise(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims  = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));

  let orig = textureLoad(srcTex, coord, 0);
  if (params.amount == 0u) {
    return orig;
  }
  // amount is a percentage; 100% → ±0.5 perceptual peak, matching the
  // legacy `amount * 127 / 100 / 255 ≈ amount / 200` calibration so the
  // slider's existing scale stays meaningful.
  let amp = f32(params.amount) * 0.005;
  let idx = u32(coord.y) * dims.x + u32(coord.x);
  var state = pixel_rng_seed(params.seed, idx);

  var noise: vec3f;
  if (params.monochromatic != 0u) {
    let d = select(sample_gaussian_f(&state), sample_uniform_f(&state), params.distribution == 0u);
    noise = vec3f(d, d, d) * amp;
  } else {
    let dR = select(sample_gaussian_f(&state), sample_uniform_f(&state), params.distribution == 0u);
    let dG = select(sample_gaussian_f(&state), sample_uniform_f(&state), params.distribution == 0u);
    let dB = select(sample_gaussian_f(&state), sample_uniform_f(&state), params.distribution == 0u);
    noise = vec3f(dR, dG, dB) * amp;
  }

  let inputIsLinear = params.inputIsLinear != 0u;
  if (!inputIsLinear) {
    // rgba8 path: src is sRGB-encoded already; add the perceptual delta
    // directly. The destination rgba8 texture clamps to [0, 1] for us.
    let outRgb = clamp(orig.rgb + noise, vec3f(0.0), vec3f(1.0));
    return vec4f(outRgb, orig.a);
  }

  // rgba32f path: HDR-preserving. Run the add in perceptual space —
  // sRGB-encode the scene-linear src, add the perceptual-amplitude noise,
  // sRGB-decode back. Both transfer functions are well-defined for
  // values > 1 (the gamma piece `pow(x, 1/2.4)` keeps growing past 1)
  // so a 2.5-linear highlight encodes to ~1.49, takes its ±amp grain,
  // and decodes back to roughly 2.5 — HDR range survives intact.
  //
  // The envelope handles the sRGB curve's piecewise definition naturally
  // (linear piece below 0.0031308, gamma piece above) without needing a
  // hand-rolled Jacobian that would have to special-case both branches.
  //
  // Only the negative side is clamped — `srgbDecode` calls `pow` and
  // negative inputs are undefined, but on the upper side we let the
  // result grow without bound to preserve HDR data.
  let origP  = srgbEncode(orig.rgb);
  let sumP   = max(origP + noise, vec3f(0.0));
  let outRgb = srgbDecode(sumP);
  return vec4f(outRgb, orig.a);
}
