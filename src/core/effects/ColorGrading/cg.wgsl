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
  hasMask : u32,
  _pad    : vec3u,
}


// ─── Luminance shift, SDR (clamps every stage into [0,1]) ─────────────────────
fn applyLumShift(rgb: vec3f, oldLum: f32, newLum: f32) -> vec3f {
  let delta    = newLum - oldLum;
  let added    = rgb + vec3f(delta);
  let scaled   = rgb * (newLum / max(oldLum, 0.001));
  let ratioW   = smoothstep(0.02, 0.1, oldLum);
  return clamp(mix(added, scaled, ratioW), vec3f(0.0), vec3f(1.0));
}

// ─── Luminance shift, HDR (clamps negatives only — preserves >1) ──────────────
fn applyLumShiftHDR(rgb: vec3f, oldLum: f32, newLum: f32) -> vec3f {
  let delta    = newLum - oldLum;
  let added    = rgb + vec3f(delta);
  let scaled   = rgb * (newLum / max(oldLum, 0.001));
  let ratioW   = smoothstep(0.02, 0.1, oldLum);
  return max(mix(added, scaled, ratioW), vec3f(0.0));
}

// ─── sRGB transfer (used by the SDR envelope on rgba32f docs) ─────────────────
fn srgbEncodeF(c: f32) -> f32 {
  let x = max(c, 0.0);
  return select(1.055 * pow(x, 1.0 / 2.4) - 0.055, x * 12.92, x <= 0.0031308);
}
fn srgbDecodeF(c: f32) -> f32 {
  let x = max(c, 0.0);
  return select(pow((x + 0.055) / 1.055, 2.4), x / 12.92, x <= 0.04045);
}
fn srgbEncode(rgb: vec3f) -> vec3f {
  return vec3f(srgbEncodeF(rgb.r), srgbEncodeF(rgb.g), srgbEncodeF(rgb.b));
}
fn srgbDecode(rgb: vec3f) -> vec3f {
  return vec3f(srgbDecodeF(rgb.r), srgbDecodeF(rgb.g), srgbDecodeF(rgb.b));
}

// ─── HSL (SDR path: defined for [0,1] RGB) ────────────────────────────────────
fn rgb2hsl(c: vec3f) -> vec3f {
  let maxC  = max(c.r, max(c.g, c.b));
  let minC  = min(c.r, min(c.g, c.b));
  let delta = maxC - minC;
  let L = (maxC + minC) * 0.5;
  var S = 0.0f;
  var H = 0.0f;
  if (delta > 0.00001) {
    S = delta / (1.0 - abs(2.0 * L - 1.0));
    if (maxC == c.r) {
      H = (c.g - c.b) / delta;
      H = H - floor(H / 6.0) * 6.0;
      H = H / 6.0;
    } else if (maxC == c.g) {
      H = ((c.b - c.r) / delta + 2.0) / 6.0;
    } else {
      H = ((c.r - c.g) / delta + 4.0) / 6.0;
    }
  }
  return vec3f(H, S, L);
}

fn hsl2rgb(hsl: vec3f) -> vec3f {
  let H = hsl.x; let S = hsl.y; let L = hsl.z;
  let C = (1.0 - abs(2.0 * L - 1.0)) * S;
  let h6 = H * 6.0;
  let X = C * (1.0 - abs(h6 - floor(h6 / 2.0) * 2.0 - 1.0));
  let m = L - C * 0.5;
  var rgb: vec3f;
  if      (h6 < 1.0) { rgb = vec3f(C, X, 0.0); }
  else if (h6 < 2.0) { rgb = vec3f(X, C, 0.0); }
  else if (h6 < 3.0) { rgb = vec3f(0.0, C, X); }
  else if (h6 < 4.0) { rgb = vec3f(0.0, X, C); }
  else if (h6 < 5.0) { rgb = vec3f(X, 0.0, C); }
  else               { rgb = vec3f(C, 0.0, X); }
  return clamp(rgb + m, vec3f(0.0), vec3f(1.0));
}

// ─── OKLab (HDR path: defined for unbounded scene-linear RGB) ─────────────────
//
// OKLab (Björn Ottosson, 2020) is a perceptually uniform colour space whose
// forward / inverse transforms are well-defined for *any* non-negative
// scene-linear RGB, including HDR (> 1) values. Hue rotations are simple
// 2D rotations in (a, b); saturation scaling is a uniform scale of (a, b);
// vibrance follows the same shape but weighted by current chroma. Lightness
// (L) is left untouched by the hue/sat stages so HDR luminance survives.
//
// The cube-root step uses `sign(x) * pow(abs(x), 1/3)` so the round-trip
// stays stable on slightly-negative LMS values (which can appear at the
// gamut edges even with positive RGB inputs).

fn cbrt_signed(x: f32) -> f32 {
  return sign(x) * pow(abs(x), 1.0 / 3.0);
}
fn cbrt3(v: vec3f) -> vec3f {
  return vec3f(cbrt_signed(v.x), cbrt_signed(v.y), cbrt_signed(v.z));
}

fn linearRgbToOklab(rgb: vec3f) -> vec3f {
  let l = 0.4122214708 * rgb.r + 0.5363325363 * rgb.g + 0.0514459929 * rgb.b;
  let m = 0.2119034982 * rgb.r + 0.6806995451 * rgb.g + 0.1073969566 * rgb.b;
  let s = 0.0883024619 * rgb.r + 0.2817188376 * rgb.g + 0.6299787005 * rgb.b;

  let lms = cbrt3(vec3f(l, m, s));

  return vec3f(
    0.2104542553 * lms.x + 0.7936177850 * lms.y - 0.0040720468 * lms.z,
    1.9779984951 * lms.x - 2.4285922050 * lms.y + 0.4505937099 * lms.z,
    0.0259040371 * lms.x + 0.7827717662 * lms.y - 0.8086757660 * lms.z,
  );
}

fn oklabToLinearRgb(lab: vec3f) -> vec3f {
  let l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  let m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  let s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;

  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;

  return vec3f(
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  );
}


struct CGParams {
  lift       : vec4f,
  gamma      : vec4f,
  gain       : vec4f,
  offset     : vec4f,
  temp       : f32,
  tint       : f32,
  contrast   : f32,
  pivot      : f32,
  midDetail  : f32,
  colorBoost : f32,
  shadows    : f32,
  highlights : f32,
  saturation : f32,
  hue        : f32,
  lumMix     : f32,
  // 0 = composite ping-pong is sRGB-encoded (rgba8 doc); 1 = scene-linear
  // floats (rgba32f doc). SDR path uses this to bridge linear → perceptual
  // for the existing 0..1 math.
  inputIsLinear : f32,
  // 0 = SDR grading (legacy clamp-at-every-stage behaviour, calibrated
  // against perceptual sRGB); 1 = HDR grading (no upper clamps, OKLab-based
  // hue/sat that accepts unbounded linear RGB, weights derived from a
  // clamped perceptual luminance so wMid doesn't go negative on HDR
  // highlights). On rgba8 docs `hdrMode = 0` is correct; on rgba32f docs
  // with HDR content the user flips this on to keep highlights >1 alive
  // through grading.
  hdrMode : f32,
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var smp      : sampler;
@group(0) @binding(2) var<uniform> params    : CGParams;
@group(0) @binding(3) var selMask  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;


// ─── SDR grading body ─────────────────────────────────────────────────────────
fn grade_sdr(srcRgb: vec3f) -> vec3f {
  let inputIsLinear = params.inputIsLinear > 0.5;
  var rgb = select(srcRgb, srgbEncode(srcRgb), inputIsLinear);
  let origLum = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));

  rgb.r += ((params.temp - 6500.0) / 5500.0) * 0.1;
  rgb.g -= (params.tint / 100.0) * 0.05;
  rgb.b -= ((params.temp - 6500.0) / 5500.0) * 0.1;
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));

  let wShadow    = 1.0 - origLum;
  let wMid       = 4.0 * origLum * (1.0 - origLum);
  let wHighlight = origLum;

  let liftRGB  = vec3f(params.lift.x  + params.lift.w,  params.lift.y  + params.lift.w,  params.lift.z  + params.lift.w);
  let gammaRGB = vec3f(params.gamma.x + params.gamma.w, params.gamma.y + params.gamma.w, params.gamma.z + params.gamma.w);
  let gainRGB  = vec3f(params.gain.x  + params.gain.w,  params.gain.y  + params.gain.w,  params.gain.z  + params.gain.w);
  let offRGB   = vec3f(params.offset.x + params.offset.w, params.offset.y + params.offset.w, params.offset.z + params.offset.w);

  rgb += liftRGB  * wShadow;     rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  rgb += gammaRGB * wMid;        rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  rgb += gainRGB  * wHighlight;  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  rgb += offRGB;                 rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));

  let pivot = clamp(params.pivot, 0.001, 0.999);

  let lumC    = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let lumCNew = clamp((lumC - pivot) * params.contrast + pivot, 0.0, 1.0);
  rgb = applyLumShift(rgb, lumC, lumCNew);

  let lum1    = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let t1      = select(lum1 * 0.5 / pivot, 0.5 + (lum1 - pivot) * 0.5 / (1.0 - pivot), lum1 >= pivot);
  let wMid1   = 4.0 * t1 * (1.0 - t1);
  let lum1New = clamp(lum1 + (params.midDetail / 100.0) * wMid1 * 0.5, 0.0, 1.0);
  rgb = applyLumShift(rgb, lum1, lum1New);

  let lum2    = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let wSh     = 1.0 - smoothstep(0.0, pivot, lum2);
  let wHl     = smoothstep(pivot, 1.0, lum2);
  let lum2New = clamp(lum2 + (params.shadows / 100.0) * 0.5 * wSh + (params.highlights / 100.0) * 0.5 * wHl, 0.0, 1.0);
  rgb = applyLumShift(rgb, lum2, lum2New);

  var hsl = rgb2hsl(rgb);
  hsl.y = clamp(hsl.y * (params.saturation / 50.0), 0.0, 1.0);
  let hueShift = (params.hue - 50.0) * 3.6 / 360.0;
  hsl.x = hsl.x + hueShift;
  hsl.x = hsl.x - floor(hsl.x);
  rgb = hsl2rgb(hsl);

  var hsl2 = rgb2hsl(rgb);
  if (hsl2.y > 0.001) {
    let boost = (params.colorBoost / 100.0) * (1.0 - hsl2.y);
    hsl2.y = clamp(hsl2.y + boost, 0.0, 1.0);
    rgb = hsl2rgb(hsl2);
  }

  let corrLum     = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let lumPreserved = applyLumShift(rgb, corrLum, origLum);
  rgb = clamp(mix(rgb, lumPreserved, params.lumMix / 100.0), vec3f(0.0), vec3f(1.0));

  return select(rgb, srgbDecode(rgb), inputIsLinear);
}


// ─── HDR grading body ─────────────────────────────────────────────────────────
//
// Operates directly on scene-linear floats (no sRGB envelope). Differences vs
// the SDR path:
//   - Per-stage clamps are `max(rgb, 0)` instead of `clamp(rgb, 0, 1)`. Values
//     > 1 ride through every stage unmolested.
//   - Tone-region weights (`wShadow`, `wMid`, `wHighlight`) are computed from a
//     `clamp(perceptualLum, 0, 1)`. Without this, an HDR pixel at perceptual
//     lum ≈ 1.49 would make `wMid = 4·1.49·(-0.49) = -2.92` (a *negative*
//     weight that *inverts* the Gamma push) and `wShadow = -0.49` (likewise).
//     Clamping at the weight-input only doesn't touch RGB.
//   - Pivot for Contrast / Mid-Detail / Shadows-Highlights is interpreted in
//     **linear** scene-referred space. A pivot of 0.435 is *linear* midgrey
//     here, not sRGB midgrey; the user will typically want to set it lower
//     (~0.18) for HDR content. The `pivot` slot is shared with SDR mode, so
//     defaults aren't auto-remapped — the dial is the same number, just
//     interpreted in whichever space the math runs in.
//   - Hue / Saturation / ColorBoost run in OKLab. Hue is a (a, b) rotation
//     by the slider angle; Saturation is uniform (a, b) scale; ColorBoost
//     scales (a, b) inversely to current chroma so already-saturated pixels
//     get less boost. None of these touch Lightness (L), so HDR luminance
//     passes through untouched.
//   - Final LumMix uses the HDR luminance-shift helper so it doesn't crush
//     highlights past 1.

fn grade_hdr(srcRgb: vec3f) -> vec3f {
  var rgb = max(srcRgb, vec3f(0.0));  // sRGB-decode artefacts can produce
                                       // slightly negative linear; clean up.

  // Perceptual luminance used ONLY for weight computation. RGB stays linear.
  let lumLinearOrig = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let lumPercOrig   = srgbEncodeF(lumLinearOrig);
  let lumW          = clamp(lumPercOrig, 0.0, 1.0);

  // Stage 1: Temp / Tint — same additive shifts, just no [0,1] clamp.
  rgb.r += ((params.temp - 6500.0) / 5500.0) * 0.1;
  rgb.g -= (params.tint / 100.0) * 0.05;
  rgb.b -= ((params.temp - 6500.0) / 5500.0) * 0.1;
  rgb = max(rgb, vec3f(0.0));

  // Stage 2: Wheels — weights from clamped perceptual lum (so HDR pixels
  // pick wHighlight=1 and the bell wMid → 0 at the upper edge).
  let wShadow    = 1.0 - lumW;
  let wMid       = 4.0 * lumW * (1.0 - lumW);
  let wHighlight = lumW;

  let liftRGB  = vec3f(params.lift.x  + params.lift.w,  params.lift.y  + params.lift.w,  params.lift.z  + params.lift.w);
  let gammaRGB = vec3f(params.gamma.x + params.gamma.w, params.gamma.y + params.gamma.w, params.gamma.z + params.gamma.w);
  let gainRGB  = vec3f(params.gain.x  + params.gain.w,  params.gain.y  + params.gain.w,  params.gain.z  + params.gain.w);
  let offRGB   = vec3f(params.offset.x + params.offset.w, params.offset.y + params.offset.w, params.offset.z + params.offset.w);

  rgb += liftRGB  * wShadow;     rgb = max(rgb, vec3f(0.0));
  rgb += gammaRGB * wMid;        rgb = max(rgb, vec3f(0.0));
  rgb += gainRGB  * wHighlight;  rgb = max(rgb, vec3f(0.0));
  rgb += offRGB;                 rgb = max(rgb, vec3f(0.0));

  // Pivot for Contrast / Mid-Detail / Shadows-Highlights. In HDR mode the
  // pivot is in scene-linear; the user is expected to set it to whatever
  // midpoint their content sits around (often 0.18 linear, sometimes 0.5).
  let pivot = max(params.pivot, 0.001);

  // Stage 3: Contrast — operates on linear luminance, no upper clamp.
  let lumC    = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let lumCNew = max((lumC - pivot) * params.contrast + pivot, 0.0);
  rgb = applyLumShiftHDR(rgb, lumC, lumCNew);

  // Stage 4: Mid/Detail — piecewise remap of lum into [0,1] around the
  // pivot is now extended past pivot=1 using the linear extrapolation, but
  // the smoothstep weight saturates so the additive term is bounded.
  let lum1     = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let lum1Norm = clamp(srgbEncodeF(lum1), 0.0, 1.0);
  let pivotPerc = srgbEncodeF(pivot);
  let t1 = select(
    lum1Norm * 0.5 / max(pivotPerc, 0.001),
    0.5 + (lum1Norm - pivotPerc) * 0.5 / max(1.0 - pivotPerc, 0.001),
    lum1Norm >= pivotPerc,
  );
  let wMid1    = 4.0 * t1 * (1.0 - t1);
  let lum1New  = max(lum1 + (params.midDetail / 100.0) * wMid1 * 0.5, 0.0);
  rgb = applyLumShiftHDR(rgb, lum1, lum1New);

  // Stage 5: Shadows / Highlights — region weights driven by perceptual lum.
  let lum2     = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let lum2Perc = clamp(srgbEncodeF(lum2), 0.0, 1.0);
  let wSh      = 1.0 - smoothstep(0.0, pivotPerc, lum2Perc);
  let wHl      = smoothstep(pivotPerc, 1.0, lum2Perc);
  let lum2New  = max(lum2 + (params.shadows / 100.0) * 0.5 * wSh + (params.highlights / 100.0) * 0.5 * wHl, 0.0);
  rgb = applyLumShiftHDR(rgb, lum2, lum2New);

  // Stages 6-7: Saturation + Hue in OKLab. Lightness untouched.
  var lab = linearRgbToOklab(rgb);
  let satFactor = params.saturation / 50.0;
  lab.y = lab.y * satFactor;
  lab.z = lab.z * satFactor;
  let hueRad = (params.hue - 50.0) * 3.6 * (3.14159265358979 / 180.0);
  let cs = cos(hueRad);
  let sn = sin(hueRad);
  let aRot = cs * lab.y - sn * lab.z;
  let bRot = sn * lab.y + cs * lab.z;
  lab.y = aRot;
  lab.z = bRot;
  rgb = max(oklabToLinearRgb(lab), vec3f(0.0));

  // Stage 8: ColorBoost (vibrance) — chroma boost weighted inversely to
  // current chroma so already-saturated pixels barely move.
  let lab2 = linearRgbToOklab(rgb);
  let C    = sqrt(lab2.y * lab2.y + lab2.z * lab2.z);
  if (C > 0.0001) {
    // Reference max chroma ~ 0.32 in OKLab for typical sRGB-gamut pixels;
    // beyond that we just clamp the relative saturation at 1 so the boost
    // can't go negative.
    let satRel = clamp(C / 0.32, 0.0, 1.0);
    let boost  = (params.colorBoost / 100.0) * (1.0 - satRel);
    let scale  = 1.0 + boost;
    rgb = max(oklabToLinearRgb(vec3f(lab2.x, lab2.y * scale, lab2.z * scale)), vec3f(0.0));
  }

  // Stage 9: Lum Mix — same shape as SDR but using the HDR luminance helper
  // and no upper clamp.
  let corrLum      = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let lumPreserved = applyLumShiftHDR(rgb, corrLum, lumLinearOrig);
  rgb = max(mix(rgb, lumPreserved, params.lumMix / 100.0), vec3f(0.0));

  return rgb;
}


@fragment
fn fs_color_grading(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);
  if (src.a < 0.0001) { return src; }

  let hdrMode = params.hdrMode > 0.5;
  let gradedRgb = select(grade_sdr(src.rgb), grade_hdr(src.rgb), hdrMode);

  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return vec4f(mix(src.rgb, gradedRgb, mask), src.a);
}
