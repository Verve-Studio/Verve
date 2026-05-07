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


// Apply a luminance change while keeping the result well-behaved at all input
// luminances. The naïve approach `rgb * (newLum / oldLum)` preserves hue
// exactly but explodes near black: a tiny denominator turns into a huge
// multiplier and amplifies whatever noise is in the shadows. Pure additive
// shift is the opposite: stable everywhere but desaturates colourful pixels.
//
// Smoothly mix between the two based on the input luminance so the ratio
// rescale dominates in mids/highs (where it's hue-preserving and well-defined)
// and the additive shift takes over in deep shadows (where ratio would
// amplify noise). The transition window 2%..10% is below the threshold where
// most images have meaningful hue information, so the desaturation in the
// additive region is barely visible.
fn applyLumShift(rgb: vec3f, oldLum: f32, newLum: f32) -> vec3f {
  let delta    = newLum - oldLum;
  let added    = rgb + vec3f(delta);
  let scaled   = rgb * (newLum / max(oldLum, 0.001));
  let ratioW   = smoothstep(0.02, 0.1, oldLum);
  return clamp(mix(added, scaled, ratioW), vec3f(0.0), vec3f(1.0));
}

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
  _pad       : f32,
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var smp      : sampler;
@group(0) @binding(2) var<uniform> params    : CGParams;
@group(0) @binding(3) var selMask  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

@fragment
fn fs_color_grading(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);
  if (src.a < 0.0001) { return src; }

  var rgb = src.rgb;
  let origLum = dot(src.rgb, vec3f(0.2126, 0.7152, 0.0722));

  // Stage 1: Temp / Tint
  rgb.r += ((params.temp - 6500.0) / 5500.0) * 0.1;
  rgb.g -= (params.tint / 100.0) * 0.05;
  rgb.b -= ((params.temp - 6500.0) / 5500.0) * 0.1;
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));

  // Stage 2: Wheels
  let wShadow    = 1.0 - origLum;
  let wMid       = 4.0 * origLum * (1.0 - origLum);
  let wHighlight = origLum;

  let liftRGB  = vec3f(params.lift.x  + params.lift.w,  params.lift.y  + params.lift.w,  params.lift.z  + params.lift.w);
  let gammaRGB = vec3f(params.gamma.x + params.gamma.w, params.gamma.y + params.gamma.w, params.gamma.z + params.gamma.w);
  let gainRGB  = vec3f(params.gain.x  + params.gain.w,  params.gain.y  + params.gain.w,  params.gain.z  + params.gain.w);
  let offRGB   = vec3f(params.offset.x + params.offset.w, params.offset.y + params.offset.w, params.offset.z + params.offset.w);

  rgb += liftRGB  * wShadow;
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  rgb += gammaRGB * wMid;
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  rgb += gainRGB  * wHighlight;
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  rgb += offRGB;
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));

  // Pivot defines the tonal mid-point used by every luminance-region stage
  // (Contrast, Mid/Detail, Shadows/Highlights) — not just Contrast. Setting
  // pivot to e.g. 0.435 (standard log mid-grey) makes them all centre on
  // that point, so the grading is consistent for log/scene-referred footage.
  // Guarded against pivot=0 or 1 to avoid divide-by-zero in the Mid/Detail
  // remap below; the guard is also applied to Contrast for consistency.
  let pivot   = clamp(params.pivot, 0.001, 0.999);

  // Stage 3: Contrast (luma-based to preserve hue/saturation)
  // Apply contrast as a luminance scale around the pivot point, then shift
  // RGB to match — applyLumShift prevents the ratio rescale from amplifying
  // noise in deep shadows when contrast pushes blacks below the pivot.
  let lumC    = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let lumCNew = clamp((lumC - pivot) * params.contrast + pivot, 0.0, 1.0);
  rgb = applyLumShift(rgb, lumC, lumCNew);

  // Stage 4: Mid/Detail — symmetric bump that peaks at lum=pivot and falls to
  // zero at both lum=0 and lum=1. Built from a piecewise-linear remap of
  // luminance into [0,1] with pivot mapped to 0.5, then a parabola
  // 4·t·(1−t). The 0.5 scale bounds the additive shift to ±0.5 so the
  // applyLumShift ratio rescale doesn't blow mids to white at the extremes.
  let lum1    = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let t1      = select(
    lum1 * 0.5 / pivot,
    0.5 + (lum1 - pivot) * 0.5 / (1.0 - pivot),
    lum1 >= pivot,
  );
  let wMid1   = 4.0 * t1 * (1.0 - t1);
  let lum1New = clamp(lum1 + (params.midDetail / 100.0) * wMid1 * 0.5, 0.0, 1.0);
  rgb = applyLumShift(rgb, lum1, lum1New);

  // Stage 5: Shadows / Highlights — additive lum shifts weighted by tone
  // region. Region split happens at pivot rather than a fixed 0.5 so the
  // boundary follows the user's chosen mid-tone. applyLumShift translates
  // the new luminance back into RGB without ratio amplification at deep
  // blacks (which would otherwise turn shadow noise into a stippled mess
  // at extreme slider values).
  let lum2    = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let wSh     = 1.0 - smoothstep(0.0, pivot, lum2);
  let wHl     = smoothstep(pivot, 1.0, lum2);
  let lum2New = clamp(lum2 + (params.shadows / 100.0) * 0.5 * wSh + (params.highlights / 100.0) * 0.5 * wHl, 0.0, 1.0);
  rgb = applyLumShift(rgb, lum2, lum2New);

  // Stage 6-7: Saturation + Hue
  var hsl = rgb2hsl(rgb);
  hsl.y = clamp(hsl.y * (params.saturation / 50.0), 0.0, 1.0);
  let hueShift = (params.hue - 50.0) * 3.6 / 360.0;
  hsl.x = hsl.x + hueShift;
  hsl.x = hsl.x - floor(hsl.x);
  rgb = hsl2rgb(hsl);

  // Stage 8: Color Boost (vibrance)
  // Skip on essentially-grey pixels: rgb2hsl returns hue=0 (red) when
  // saturation is zero, so boosting a fully grey pixel would convert it to
  // red rather than leaving it grey.
  var hsl2 = rgb2hsl(rgb);
  if (hsl2.y > 0.001) {
    let boost = (params.colorBoost / 100.0) * (1.0 - hsl2.y);
    hsl2.y = clamp(hsl2.y + boost, 0.0, 1.0);
    rgb = hsl2rgb(hsl2);
  }

  // Stage 9: Lum Mix — at lumMix=100 the output's luminance is forced back
  // to the original input's, turning the whole grade into a colour-only
  // operation. Routing through applyLumShift prevents the same near-black
  // ratio explosion fixed in Stages 3-5: when a stage pushed the corrected
  // luminance toward zero but origLum was larger, a naive ratio rescale
  // would amplify the near-zero RGB into a blown-out pixel.
  let corrLum     = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let lumPreserved = applyLumShift(rgb, corrLum, origLum);
  rgb = clamp(mix(rgb, lumPreserved, params.lumMix / 100.0), vec3f(0.0), vec3f(1.0));

  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return vec4f(mix(src.rgb, rgb, mask), src.a);
}
