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

struct FilmGrainCombineParams {
  intensity     : u32,  // 1–200 (%)
  roughness     : u32,  // 0–100
  inputIsLinear : u32,  // 0 = sRGB input (rgba8 doc), 1 = scene-linear (rgba32f)
  _pad1         : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var noiseTex        : texture_2d<f32>;
@group(0) @binding(3) var<uniform> params : FilmGrainCombineParams;

// Grain amplitude (127/255) was scaled for sRGB bytes; the luma weighting
// (`1 - luma`) inverts perceptual brightness. Run the additive composite
// in perceptual space so the visible grain matches the rgba8 calibration.
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

@fragment
fn fs_film_grain_combine(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord      = vec2i(i32(in.pos.x), i32(in.pos.y));
  let orig       = textureLoad(srcTex,   coord, 0);
  let noiseTexel = textureLoad(noiseTex, coord, 0);

  let inputIsLinear = params.inputIsLinear != 0u;
  let origP = select(orig.rgb, srgbEncode(orig.rgb), inputIsLinear);

  let noiseVal   = noiseTexel.r * 2.0 - 1.0;
  let intensityF = f32(params.intensity) / 100.0;
  let roughnessF = f32(params.roughness) / 100.0;

  // Luma weighting uses the *clamped-to-SDR* perceptual luma so the
  // `1 - luma` shadow bias keeps its calibrated meaning — an HDR pixel at
  // perceptual ~1.5 would otherwise produce a negative weight and grain
  // direction would flip. Capping at 1 also matches the rgba8 reference.
  let lumaP  = 0.299 * origP.r + 0.587 * origP.g + 0.114 * origP.b;
  let lumaC  = clamp(lumaP, 0.0, 1.0);
  let weight = (1.0 - roughnessF) * (1.0 - lumaC) + roughnessF * 1.0;

  let grainVal = noiseVal * (127.0 / 255.0) * weight * intensityF;

  if (!inputIsLinear) {
    // rgba8 path: clamp to [0,1] — destination texture only holds SDR.
    let outRgb = clamp(origP + grainVal, vec3f(0.0), vec3f(1.0));
    return vec4f(outRgb, orig.a);
  }

  // rgba32f path: add grain in perceptual space, decode back to scene-
  // linear without an upper clamp so HDR highlights survive the grain
  // pass. Only the negative side is clipped — `srgbDecode` is undefined
  // for negative inputs.
  let sumP   = max(origP + grainVal, vec3f(0.0));
  let outRgb = srgbDecode(sumP);
  return vec4f(outRgb, orig.a);
}
