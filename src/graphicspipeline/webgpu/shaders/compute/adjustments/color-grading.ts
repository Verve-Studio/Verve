import { ADJ_VERTEX_SHADER, MASK_FLAGS_STRUCT, HSL_HELPERS } from './helpers'

export const CG_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
${MASK_FLAGS_STRUCT}
${HSL_HELPERS}

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

  // Stage 3: Contrast (luma-based to preserve hue/saturation)
  // Apply contrast as a luminance scale around the pivot point, then ratio-scale
  // RGB channels to match — prevents per-channel clipping from shifting hue.
  let lumC = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let lumCNew = clamp((lumC - params.pivot) * params.contrast + params.pivot, 0.0, 1.0);
  if (lumC > 0.0001) { rgb = clamp(rgb * (lumCNew / lumC), vec3f(0.0), vec3f(1.0)); }

  // Stage 4: Mid/Detail — uniformly lifts or lowers the midtone range without
  // affecting pure black or white. wMid1 peaks at 1.0 when lum=0.5 and falls
  // smoothly to 0 at lum=0 and lum=1, so the adjustment is centred on grey.
  let lum1     = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let wMid1    = 4.0 * lum1 * (1.0 - lum1);
  let lum1New  = clamp(lum1 + (params.midDetail / 100.0) * wMid1, 0.0, 1.0);
  if (lum1 > 0.0001) { rgb = clamp(rgb * (lum1New / lum1), vec3f(0.0), vec3f(1.0)); }
  else { rgb = vec3f(lum1New); }

  // Stage 5: Shadows / Highlights (luma-based to preserve hue)
  // Compute target luminance from the additive delta, then ratio-scale RGB channels
  // to reach it — prevents per-channel clipping from shifting hue into pure primaries.
  let lum2    = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let wSh     = 1.0 - smoothstep(0.0, 0.5, lum2);
  let wHl     = smoothstep(0.5, 1.0, lum2);
  let lum2New = clamp(lum2 + (params.shadows / 100.0) * 0.5 * wSh + (params.highlights / 100.0) * 0.5 * wHl, 0.0, 1.0);
  if (lum2 > 0.0001) { rgb = clamp(rgb * (lum2New / lum2), vec3f(0.0), vec3f(1.0)); }
  else { rgb = vec3f(lum2New); }

  // Stage 6-7: Saturation + Hue
  var hsl = rgb2hsl(rgb);
  hsl.y = clamp(hsl.y * (params.saturation / 50.0), 0.0, 1.0);
  let hueShift = (params.hue - 50.0) * 3.6 / 360.0;
  hsl.x = hsl.x + hueShift;
  hsl.x = hsl.x - floor(hsl.x);
  rgb = hsl2rgb(hsl);

  // Stage 8: Color Boost (vibrance)
  var hsl2 = rgb2hsl(rgb);
  let boost = (params.colorBoost / 100.0) * (1.0 - hsl2.y);
  hsl2.y = clamp(hsl2.y + boost, 0.0, 1.0);
  rgb = hsl2rgb(hsl2);

  // Stage 9: Lum Mix
  let corrLum     = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  var lumPreserved = rgb;
  if (corrLum > 0.0001) { lumPreserved = rgb * (origLum / corrLum); }
  rgb = clamp(mix(rgb, lumPreserved, params.lumMix / 100.0), vec3f(0.0), vec3f(1.0));

  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return vec4f(mix(src.rgb, rgb, mask), src.a);
}
` as const
