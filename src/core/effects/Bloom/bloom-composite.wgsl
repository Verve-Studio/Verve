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


struct BloomCompositeParams {
  strength      : f32,
  inputIsLinear : f32,
  _pad1         : f32,
  _pad2         : f32,
}

@group(0) @binding(0) var srcTex       : texture_2d<f32>;
@group(0) @binding(1) var smp          : sampler;
@group(0) @binding(2) var glowTex      : texture_2d<f32>;
@group(0) @binding(3) var<uniform> params    : BloomCompositeParams;
@group(0) @binding(4) var selMask      : texture_2d<f32>;
@group(0) @binding(5) var<uniform> maskFlags : MaskFlags;

// Two different composite strategies depending on the doc's pixel format:
//
// - rgba8 docs use the legacy **screen blend** `1 − (1−src)(1−g)` in
//   perceptual space. This is what the user calibrated against; the
//   formula asymptotically clamps to 1 so it stays inside the 8-bit
//   destination range automatically.
//
// - rgba32f docs use **additive blending in scene-linear** —
//   `out = src + glow * strength` — which is the physically-correct
//   "add emitted light" operation and is how real-time HDR bloom is
//   implemented in PBR renderers. A 2.5-linear src highlight + 0.5
//   linear glow yields 3.0 linear: HDR survives, and the bloom actually
//   adds energy on top of bright pixels instead of being absorbed by the
//   screen-blend's `1 − (1−1.49)(1−g) → 1.49+ish` asymptote.
//
// The extract stage already emits `glow = src * w` in the source's native
// space (linear for rgba32f, perceptual for rgba8), and the box blur is
// space-agnostic, so both inputs reach the composite in the right space
// without any further conversion needed.
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

@fragment
fn fs_bloom_composite(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src  = textureSample(srcTex,  smp, in.uv);
  let glow = textureSample(glowTex, smp, in.uv);
  let inputIsLinear = params.inputIsLinear > 0.5;

  var outRgb : vec3f;
  if (inputIsLinear) {
    // HDR-preserving additive composite. No upper clamp; values >1 are
    // valid scene-referred energy and survive into the destination
    // (which is rgba16/32f and can hold them).
    outRgb = max(src.rgb + glow.rgb * params.strength, vec3f(0.0));
  } else {
    // Legacy SDR screen blend in perceptual sRGB. `glow` is clamped per
    // channel so a strength > 1 doesn't push (1 − g) negative — keeps the
    // formula in its well-behaved monotonic range.
    let g    = clamp(glow.rgb * params.strength, vec3f(0.0), vec3f(1.0));
    outRgb   = 1.0 - (1.0 - src.rgb) * (1.0 - g);
  }

  let out = vec4f(outRgb, src.a);
  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return mix(src, out, mask);
}
