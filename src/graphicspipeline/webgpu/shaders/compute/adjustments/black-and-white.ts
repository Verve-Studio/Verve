import { ADJ_VERTEX_SHADER, MASK_FLAGS_STRUCT, HSL_HELPERS, HUE_DIST } from './helpers'

export const BW_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
${MASK_FLAGS_STRUCT}
${HSL_HELPERS}
${HUE_DIST}

struct BWParams {
  reds     : f32,
  yellows  : f32,
  greens   : f32,
  cyans    : f32,
  blues    : f32,
  magentas : f32,
  _pad     : vec2f,
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var smp      : sampler;
@group(0) @binding(2) var<uniform> params    : BWParams;
@group(0) @binding(3) var selMask  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

@fragment
fn fs_black_and_white(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);
  if (src.a < 0.0001) { return src; }

  let hsl = rgb2hsl(src.rgb);
  let H = hsl.x; let S = hsl.y; let L = hsl.z;

  let wR = max(0.0, 1.0 - 6.0 * hueDist(H, 0.0 / 6.0));
  let wY = max(0.0, 1.0 - 6.0 * hueDist(H, 1.0 / 6.0));
  let wG = max(0.0, 1.0 - 6.0 * hueDist(H, 2.0 / 6.0));
  let wC = max(0.0, 1.0 - 6.0 * hueDist(H, 3.0 / 6.0));
  let wB = max(0.0, 1.0 - 6.0 * hueDist(H, 4.0 / 6.0));
  let wM = max(0.0, 1.0 - 6.0 * hueDist(H, 5.0 / 6.0));

  let uniformSlider = (params.reds + params.yellows + params.greens + params.cyans + params.blues + params.magentas) / 6.0;
  let hueBased      = wR * params.reds + wY * params.yellows + wG * params.greens
                    + wC * params.cyans + wB * params.blues  + wM * params.magentas;
  let satBlend      = clamp(S * 10.0, 0.0, 1.0);
  let weightedSlider = mix(uniformSlider, hueBased, satBlend);
  let gray = clamp(2.0 * L * weightedSlider / 100.0, 0.0, 1.0);

  let adjusted = vec4f(gray, gray, gray, src.a);
  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return mix(src, adjusted, mask);
}
` as const
