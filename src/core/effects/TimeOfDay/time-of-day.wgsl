// Time of Day — relights the image for dawn / day / dusk / night.
//
// Per pixel, in OKLab (the same model as the Time of Day palette generator):
//   1. Base: lightness from photopic → rod-weighted luminance (Purkinje
//      shift, strongest at night) times exposure; chroma = the pixel's own
//      chroma × retention + the light tint.
//   2. Tonal position (from the pixel's original lightness) picks the tint:
//      shadows lean to the shadow tint and deepen, highlights lift towards
//      the key light (sun / moon); midtones keep the base tint.
//   3. Gamut: chroma is reduced (never hue or lightness) until it fits.
// Scene-linear inputs (float documents) stay linear and may exceed 1 (HDR).

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

struct MaskFlags {
  hasMask       : u32,
  inputIsLinear : u32,
  _pad          : vec2u,
}

// Must match the Float32Array packed in TimeOfDayEffect.encode (80 bytes).
struct TodParams {
  tintA             : f32,
  tintB             : f32,
  shadowA           : f32,
  shadowB           : f32,
  lightA            : f32,
  lightB            : f32,
  tintStrength      : f32,
  retention         : f32,
  exposure          : f32,
  purkinje          : f32,
  purkinjeMix       : f32,
  tintChroma        : f32,
  shadowChroma      : f32,
  lightChroma       : f32,
  shadowDepth       : f32,
  highlightStrength : f32,
  amount            : f32,
  _pad0             : f32,
  _pad1             : f32,
  _pad2             : f32,
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var smp      : sampler;
@group(0) @binding(2) var<uniform> params    : TodParams;
@group(0) @binding(3) var selMask  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

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

fn cbrtS(x: f32) -> f32 { return sign(x) * pow(abs(x), 1.0 / 3.0); }

fn linToOklab(c: vec3f) -> vec3f {
  let l = cbrtS(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b);
  let m = cbrtS(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b);
  let s = cbrtS(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
  return vec3f(
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  );
}

fn oklabToLin(lab: vec3f) -> vec3f {
  let l = pow3(lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z);
  let m = pow3(lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z);
  let s = pow3(lab.x - 0.0894841775 * lab.y - 1.291485548 * lab.z);
  return vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  );
}

fn pow3(x: f32) -> f32 { return x * x * x; }

fn inGamut(c: vec3f, maxV: f32) -> bool {
  return all(c >= vec3f(-1e-4)) && all(c <= vec3f(maxV + 1e-4));
}

/// OKLab → linear RGB, reducing chroma until the colour fits.
fn toGamut(lab: vec3f, maxV: f32) -> vec3f {
  let full = oklabToLin(lab);
  if (inGamut(full, maxV)) { return full; }
  var lo = 0.0;
  var hi = 1.0;
  for (var i = 0; i < 12; i++) {
    let mid = 0.5 * (lo + hi);
    if (inGamut(oklabToLin(vec3f(lab.x, lab.yz * mid)), maxV)) { lo = mid; } else { hi = mid; }
  }
  return clamp(oklabToLin(vec3f(lab.x, lab.yz * lo)), vec3f(0.0), vec3f(maxV));
}

@fragment
fn fs_time_of_day(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);
  if (src.a < 0.0001) { return src; }

  let inputIsLinear = maskFlags.inputIsLinear != 0u;
  let lin = select(srgbDecode(src.rgb), src.rgb, inputIsLinear);
  let lab = linToOklab(lin);

  // ── Base relight ──
  let yDay = dot(lin, vec3f(0.2126, 0.7152, 0.0722));
  let yRod = dot(lin, vec3f(0.07, 0.45, 0.48));
  let rodL = cbrtS(mix(yDay, yRod, params.purkinje));
  let srcL = mix(lab.x, rodL, params.purkinjeMix);
  let baseL = srcL * params.exposure;
  let tintC = params.tintChroma * min(1.0, baseL / 0.45);
  var ab = lab.yz * params.retention + vec2f(params.tintA, params.tintB) * tintC * params.tintStrength;
  var L = baseL;

  // ── Tonal position picks the tint ──
  let tone = clamp(lab.x, 0.0, 1.0);
  let shadowW = (1.0 - smoothstep(0.1, 0.55, tone)) * params.shadowDepth;
  let highlightW = smoothstep(0.5, 0.95, tone) * params.highlightStrength;

  // Shadows: deeper, towards the ambient shadow tint.
  if (shadowW > 0.0) {
    L = L * (1.0 - 0.35 * shadowW);
    let shadC = params.shadowChroma * min(1.0, L / 0.35);
    ab = mix(ab, vec2f(params.shadowA, params.shadowB) * shadC, shadowW) * (1.0 - 0.3 * shadowW);
  }
  // Highlights: surfaces facing the key light keep their brightness and
  // take its colour.
  if (highlightW > 0.0) {
    let peakL = min(0.94, max(baseL + 0.18, lab.x * 0.92 + 0.08));
    L = mix(L, max(L, peakL), highlightW * 0.6);
    ab = mix(ab, vec2f(params.lightA, params.lightB) * params.lightChroma, min(1.0, highlightW * 0.9));
  }

  let maxV = select(1.0, 1e6, inputIsLinear);
  let outLin = toGamut(vec3f(L, ab), maxV);
  let outRgb = select(srgbEncode(outLin), outLin, inputIsLinear);
  let relit = vec4f(mix(src.rgb, outRgb, params.amount), src.a);

  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return mix(src, relit, mask);
}
