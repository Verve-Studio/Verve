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


fn srgb_to_linear(c: vec3f) -> vec3f {
  return select(c / 12.92,
                pow((c + 0.055) / 1.055, vec3f(2.4)),
                c > vec3f(0.04045));
}
fn linear_to_srgb(c: vec3f) -> vec3f {
  return select(c * 12.92,
                1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055,
                c > vec3f(0.0031308));
}
fn linear_srgb_to_oklab(c: vec3f) -> vec3f {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  let l_ = pow(max(l, 0.0), 1.0 / 3.0);
  let m_ = pow(max(m, 0.0), 1.0 / 3.0);
  let s_ = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3f(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  );
}
fn oklab_to_linear_srgb(lab: vec3f) -> vec3f {
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
