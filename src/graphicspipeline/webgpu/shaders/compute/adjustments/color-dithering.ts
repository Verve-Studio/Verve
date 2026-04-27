import { ADJ_VERTEX_SHADER, MASK_FLAGS_STRUCT, OKLAB_HELPERS } from './helpers'

export const DITHER_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
${MASK_FLAGS_STRUCT}
${OKLAB_HELPERS}

const BAYER4 = array<u32, 16>(
   0u,  8u,  2u, 10u,
  12u,  4u, 14u,  6u,
   3u, 11u,  1u,  9u,
  15u,  7u, 13u,  5u
);

const BAYER8 = array<u32, 64>(
   0u, 32u,  8u, 40u,  2u, 34u, 10u, 42u,
  48u, 16u, 56u, 24u, 50u, 18u, 58u, 26u,
  12u, 44u,  4u, 36u, 14u, 46u,  6u, 38u,
  60u, 28u, 52u, 20u, 62u, 30u, 54u, 22u,
   3u, 35u, 11u, 43u,  1u, 33u,  9u, 41u,
  51u, 19u, 59u, 27u, 49u, 17u, 57u, 25u,
  15u, 47u,  7u, 39u, 13u, 45u,  5u, 37u,
  63u, 31u, 55u, 23u, 61u, 29u, 53u, 21u
);

struct DitheringParams {
  paletteCount : u32,
  style        : u32,
  opacity      : u32,
  _pad         : u32,
}

@group(0) @binding(0) var srcTex            : texture_2d<f32>;
@group(0) @binding(1) var smp               : sampler;
@group(0) @binding(2) var<uniform> params   : DitheringParams;
@group(0) @binding(3) var selMask           : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags: MaskFlags;
@group(0) @binding(5) var<storage, read> palette: array<vec4f>;

fn nearest_palette_color(col: vec3f) -> vec3f {
  var bestIdx  : u32 = 0u;
  var bestDist : f32 = 1.0e30;
  for (var i: u32 = 0u; i < params.paletteCount; i++) {
    let d = dot(col - palette[i].xyz, col - palette[i].xyz);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return palette[bestIdx].xyz;
}

@fragment
fn fs_color_dithering(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);

  if (src.a < 0.0001 || params.paletteCount == 0u) {
    return src;
  }

  let px = u32(in.pos.x);
  let py = u32(in.pos.y);
  let srcLin = srgb_to_linear(src.rgb);

  var threshold = 0.0f;
  if (params.style == 0u) {
    let bx  = px % 4u;
    let by  = py % 4u;
    let idx = by * 4u + bx;
    threshold = (f32(BAYER4[idx]) / 16.0) - 0.5;
  } else if (params.style == 1u) {
    let bx  = px % 8u;
    let by  = py % 8u;
    let idx = by * 8u + bx;
    threshold = (f32(BAYER8[idx]) / 64.0) - 0.5;
  }

  let spread   = 1.0 / max(f32(params.paletteCount), 2.0);
  let dithered = clamp(srcLin + threshold * spread, vec3f(0.0), vec3f(1.0));

  let bestLin  = nearest_palette_color(dithered);
  let bestSrgb = linear_to_srgb(bestLin);
  let adjusted = vec4f(bestSrgb, src.a);

  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  let opacityF = f32(params.opacity) / 100.0;
  let blended = mix(src, adjusted, opacityF);
  return mix(src, blended, mask);
}
` as const
