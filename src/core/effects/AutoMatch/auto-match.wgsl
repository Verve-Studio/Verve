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


// AutoMatchParams layout (128 bytes):
//   layerStats   = vec4f(meanL, stdL, minL, maxL)
//   layerColor   = vec4f(meanR, meanG, meanB, valid01)
//   contextStats = vec4f(meanL, stdL, minL, maxL)
//   contextColor = vec4f(meanR, meanG, meanB, valid01)
//   factors      = vec4f(strength, brightness, contrast, gamma)
//   colorFactor  = vec4f(color, saturation, _, _)
//   flags        = vec4u(clampHighlights, clampShadows, _, _)
//   extraStats   = vec4f(layerChromaMag, contextChromaMag, _, _)
struct AutoMatchParams {
  layerStats   : vec4f,
  layerColor   : vec4f,
  contextStats : vec4f,
  contextColor : vec4f,
  factors      : vec4f,
  colorFactor  : vec4f,
  flags        : vec4u,
  extraStats   : vec4f,
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var smp      : sampler;
@group(0) @binding(2) var<uniform> params    : AutoMatchParams;
@group(0) @binding(3) var selMask  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs_auto_match(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);
  if (src.a < 0.0001) { return src; }

  // No-op if either side has no opaque pixels to base statistics on.
  let valid = params.layerColor.w * params.contextColor.w;
  if (valid < 0.5) { return src; }

  let s_global  = params.factors.x;
  if (s_global <= 0.0) { return src; }

  let f_b   = clamp(params.factors.y, 0.0, 2.0);
  let f_c   = clamp(params.factors.z, 0.0, 2.0);
  let f_g   = clamp(params.factors.w, 0.0, 2.0);
  let f_col = clamp(params.colorFactor.x, 0.0, 2.0);
  let f_sat = clamp(params.colorFactor.y, 0.0, 2.0);

  let layerL    = params.layerStats.x;
  let ctxL      = params.contextStats.x;
  let ctxMin    = params.contextStats.z;
  let ctxMax    = params.contextStats.w;

  let layerStd  = max(params.layerStats.y, 1e-3);
  let ctxStd    = max(params.contextStats.y, 0.0);

  let layerRgb  = params.layerColor.xyz;
  let ctxRgb    = params.contextColor.xyz;

  let inputIsLinear = maskFlags.inputIsLinear != 0u;
  let srcP = select(src.rgb, srgbEncode(src.rgb), inputIsLinear);
  var rgb = srcP;

  // ── 1. Brightness — multiplicative luma gain ───────────────────────────────
  // Multiplicative scaling of RGB is hue-preserving and proportional: a
  // bright highlight (e.g. specular face pixel) is attenuated by the same
  // *ratio* as a dim shadow, which is how natural lighting actually behaves.
  // An equivalent-magnitude additive shift would crush the shadows to zero
  // long before the highlights darkened enough to read as belonging to the
  // surroundings, which is the failure mode we hit with a contrasty subject
  // (face highlights + dark dress) in a moody scene.
  // Tightly cap the gain to [0.7, 1.43] (≈±40%) so even at full slider
  // strength the brightness shift is a gentle integration nudge rather than
  // a forced collapse to context mean. The slider extrapolates past 1× via
  // mix(), so brightness=200 still gets users a stronger correction when
  // they genuinely need one (e.g. daylight subject in a sunset scene).
  let brightGainRaw = ctxL / max(layerL, 0.05);
  let brightGainCap = clamp(brightGainRaw, 0.7, 1.43);
  let brightGain    = clamp(mix(1.0, brightGainCap, f_b), 0.4, 2.5);
  rgb = rgb * brightGain;

  // ── 2. Contrast — additive scaling around the post-brightness mean ─────────
  // The brightness step has already scaled the layer's luma std by `brightGain`
  // (multiplicative gain scales mean and std together). Re-derive the contrast
  // scale from the post-brightness std so we land at ctxStd, not somewhere
  // halfway. Apply as a uniform RGB delta to preserve hue.
  let postLayerL    = layerL * brightGain;
  let postLayerStd  = max(layerStd * brightGain, 1e-3);
  let stdRatioRaw   = ctxStd / postLayerStd;
  let stdRatioGated = select(1.0, clamp(stdRatioRaw, 0.5, 2.0),
                             params.layerStats.y > 1e-3);
  let scale = mix(1.0, stdRatioGated, f_c);
  let l1    = luma(rgb);
  let l1c   = l1 - postLayerL;
  rgb = rgb + vec3f(l1c * (scale - 1.0));

  // ── 3. Gamma — multiplicative on luma (hue-preserving) ─────────────────────
  // `pow` on the luma component, then scale RGB by the ratio. Pure black
  // pixels stay black; chromaticity is unchanged.
  let logLayer = log(clamp(layerL, 0.1, 0.9));
  let logCtx   = log(clamp(ctxL,   0.1, 0.9));
  let kRaw     = logCtx / logLayer;
  let kEff     = mix(1.0, clamp(kRaw, 0.85, 1.18), f_g);
  let l2       = max(luma(rgb), 1e-4);
  let l2c      = clamp(l2, 0.0, 1.0);
  let l2_new   = pow(l2c, kEff);
  rgb = rgb * (l2_new / l2);

  // ── 4. Color — gentle ambient tint ─────────────────────────────────────────
  // Match the *direction* of the scene's chromatic bias relative to neutral
  // gray, but cap its magnitude so a strongly-coloured layer (e.g. a purple
  // dress against a mostly-gray landscape) isn't yanked toward scene mean.
  let layerCast = layerRgb - vec3f(layerL);
  let ctxCast   = ctxRgb   - vec3f(ctxL);
  let castDelta = ctxCast - layerCast;
  let castMag   = length(castDelta);
  let CAST_CAP  = 0.12;
  let castScale = select(1.0, CAST_CAP / castMag, castMag > CAST_CAP);
  rgb = rgb + castDelta * castScale * f_col;

  // ── 4b. Saturation — scale chroma magnitude toward context ─────────────────
  // Without this step a vivid layer (saturated subject) keeps its full
  // chromatic punch even when dropped into a muted scene, which is the
  // single largest "still doesn't fit" cue. We compute each pixel's chroma
  // (rgb − luma·1) and rescale it by ctxChromaMag / layerChromaMag, capped to
  // ±2× so we don't fully desaturate a colourful layer in a near-grayscale
  // environment (or the reverse).
  let layerChroma = max(params.extraStats.x, 1e-3);
  let ctxChroma   = params.extraStats.y;
  let satRatio    = clamp(ctxChroma / layerChroma, 0.4, 1.6);
  let satEff      = mix(1.0, satRatio, f_sat);
  let lcur        = luma(rgb);
  let chroma      = rgb - vec3f(lcur);
  rgb = vec3f(lcur) + chroma * satEff;

  // ── 5. Clamp luma into context dynamic range ───────────────────────────────
  // Brightest pixel of the layer ≤ brightest pixel of the rest of the image,
  // and darkest pixel ≥ darkest of the rest. Apply as a uniform luma scale so
  // hue survives.
  let lf = max(luma(rgb), 1e-4);
  var lo = 0.0;
  var hi = 1.0;
  if (params.flags.y != 0u) { lo = ctxMin; }
  if (params.flags.x != 0u) { hi = ctxMax; }
  let lc = clamp(lf, lo, hi);
  rgb = rgb * (lc / lf);

  // ── 6. Strength — final blend back toward source ───────────────────────────
  rgb = mix(srcP, rgb, s_global);

  let percRgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  let outRgb = select(percRgb, srgbDecode(percRgb), inputIsLinear);
  let adjusted = vec4f(outRgb, src.a);

  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) {
    mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
  }
  return mix(src, adjusted, mask);
}
