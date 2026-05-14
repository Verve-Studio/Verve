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

struct PlasticWrapParams {
  highlightStrength: f32,  // 0..20
  detail           : f32,  // 1..15
  smoothness       : f32,  // 1..15
  _pad             : f32,
}

@group(0) @binding(0) var srcTex     : texture_2d<f32>;
@group(0) @binding(1) var smp        : sampler;
@group(0) @binding(2) var<uniform>   params    : PlasticWrapParams;
@group(0) @binding(3) var selMask    : texture_2d<f32>;
@group(0) @binding(4) var<uniform>   maskFlags : MaskFlags;

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }

fn clampPx(p: vec2i, dims: vec2i) -> vec2i {
  return clamp(p, vec2i(0), dims - vec2i(1));
}

/** Sobel-style luminance gradient at `coord`. The cross is offset by
 *  `detailStep` so larger detail values produce a wider ridge response
 *  (broader plastic crinkles). */
fn lumaGradient(coord: vec2i, detailStep: i32, dims: vec2i, inputIsLinear: bool) -> vec2f {
  let llS = textureLoad(srcTex, clampPx(coord + vec2i(-detailStep, 0), dims), 0).rgb;
  let rrS = textureLoad(srcTex, clampPx(coord + vec2i( detailStep, 0), dims), 0).rgb;
  let ttS = textureLoad(srcTex, clampPx(coord + vec2i(0, -detailStep), dims), 0).rgb;
  let bbS = textureLoad(srcTex, clampPx(coord + vec2i(0,  detailStep), dims), 0).rgb;
  let ll = luma(select(llS, srgbEncode(llS), inputIsLinear));
  let rr = luma(select(rrS, srgbEncode(rrS), inputIsLinear));
  let tt = luma(select(ttS, srgbEncode(ttS), inputIsLinear));
  let bb = luma(select(bbS, srgbEncode(bbS), inputIsLinear));
  return vec2f((rr - ll) * 0.5, (bb - tt) * 0.5);
}

@fragment
fn fs_plastic_wrap(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims = vec2i(textureDimensions(srcTex));
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let src = textureLoad(srcTex, coord, 0);

  let inputIsLinear = maskFlags.inputIsLinear != 0u;
  let srcP = select(src.rgb, srgbEncode(src.rgb), inputIsLinear);

  // Detail (1..15) drives the gradient sampling distance — the bigger the
  // step, the bigger the plastic-crinkle features.
  let detailStep = max(1, i32(round(params.detail * 0.6)));
  let g = lumaGradient(coord, detailStep, dims, inputIsLinear);
  var gradMag = length(g);

  // Smoothness (1..15) → mean blur of the gradient magnitude so highlights
  // form continuous "ridges" instead of pixel-thin lines.
  let smoothR = min(8, i32(round(params.smoothness * 0.5)));
  if (smoothR > 0) {
    var sum = 0.0;
    var count = 0.0;
    for (var dy = -smoothR; dy <= smoothR; dy = dy + 1) {
      for (var dx = -smoothR; dx <= smoothR; dx = dx + 1) {
        let c = clamp(coord + vec2i(dx, dy), vec2i(0), dims - vec2i(1));
        let gg = lumaGradient(c, detailStep, dims, inputIsLinear);
        sum = sum + length(gg);
        count = count + 1.0;
      }
    }
    gradMag = sum / count;
  }

  // The ridge response is squashed through an exposure curve to give the
  // characteristic "wet sheen" — sharp highlights with rapid falloff.
  let strength = params.highlightStrength * 0.15; // 0..3
  let highlight = clamp(pow(gradMag, 0.5) * strength, 0.0, 1.0);

  // Screen-blend the highlight over the source.
  let out = vec3f(1.0) - (vec3f(1.0) - srcP) * (vec3f(1.0) - vec3f(highlight));

  let outRgb = select(out, srgbDecode(out), inputIsLinear);
  let result = vec4f(outRgb, src.a);
  if (maskFlags.hasMask != 0u) {
    let m = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    return mix(src, result, m);
  }
  return result;
}
