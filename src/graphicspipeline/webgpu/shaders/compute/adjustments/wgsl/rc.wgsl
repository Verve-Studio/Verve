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


struct RCParams {
  paletteCount : u32,
  _pad         : vec3u,
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var smp      : sampler;
@group(0) @binding(2) var<uniform> params    : RCParams;
@group(0) @binding(3) var selMask  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;
@group(0) @binding(5) var<storage, read> palette : array<vec4f>;

@fragment
fn fs_reduce_colors(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);

  if (src.a < 0.0001 || params.paletteCount == 0u) {
    return src;
  }

  let srcLinear = srgb_to_linear(src.rgb);
  let srcLab    = linear_srgb_to_oklab(srcLinear);

  var bestIdx  : u32 = 0u;
  var bestDist : f32 = 1.0e30;
  for (var i: u32 = 0u; i < params.paletteCount; i++) {
    let pLab = palette[i].xyz;
    let d    = dot(srcLab - pLab, srcLab - pLab);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }

  let bestLinear = oklab_to_linear_srgb(palette[bestIdx].xyz);
  let bestSrgb   = linear_to_srgb(bestLinear);
  let adjusted   = vec4f(bestSrgb, src.a);

  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return mix(src, adjusted, mask);
}
