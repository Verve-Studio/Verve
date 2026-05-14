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


struct HalationExtractParams {
  threshold     : f32,
  inputIsLinear : f32,
  _pad1         : f32,
  _pad2         : f32,
}

@group(0) @binding(0) var srcTex              : texture_2d<f32>;
@group(0) @binding(1) var smp                 : sampler;
@group(0) @binding(2) var<uniform> params     : HalationExtractParams;
@group(0) @binding(3) var selMask             : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags  : MaskFlags;

// Evaluate the threshold + apply the perceptual orange tint in sRGB space.
// `vec3(1.0, 0.22, 0.05)` was authored against perceptual brightness; on a
// linear input it multiplies values that are already much smaller than
// they'd be in sRGB, producing a markedly different (typically too-strong
// in display) warm glow.
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
fn fs_halation_extract(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src   = textureSample(srcTex, smp, in.uv);
  let inputIsLinear = params.inputIsLinear > 0.5;

  // Threshold is evaluated against perceptual luminance — the user-facing
  // `threshold` slider is calibrated against 0..1 perceptual brightness.
  // For HDR src the perceptual lum can exceed 1 (`srgbEncode(2.5) ≈ 1.49`)
  // which trips the smoothstep to its full-glow plateau — i.e. every HDR
  // pixel contributes, which is exactly what we want.
  let percRgb = select(src.rgb, srgbEncode(src.rgb), inputIsLinear);
  let lum = dot(percRgb, vec3f(0.2126, 0.7152, 0.0722));
  let t   = params.threshold;
  let k   = 0.1;
  let w   = smoothstep(t - k, t + k, lum);

  // Tint authoring lives in perceptual sRGB (`vec3(1.0, 0.22, 0.05)` is
  // the warm orange the user dialled in on rgba8). The tint is a per-
  // channel MULTIPLIER — applying it in perceptual on rgba8 vs in linear
  // on rgba32f gives two quite different multipliers. To preserve the
  // visible warm character while keeping the glow in scene-referred
  // linear space (so HDR src highlights produce HDR halation glow),
  // we convert the authored perceptual tint to its linear equivalent
  // once, then multiply in linear.
  let tintP      = vec3f(1.0, 0.22, 0.05);
  let tintLinear = srgbDecode(tintP);

  var glowRgb : vec3f;
  if (inputIsLinear) {
    // Linear path: multiply scene-linear src by the linear tint. A
    // 2.5-linear src highlight produces a 2.5-linear halation red
    // channel — full HDR survival.
    glowRgb = src.rgb * tintLinear * w;
  } else {
    // rgba8 path: legacy perceptual multiplication.
    glowRgb = src.rgb * tintP * w;
  }

  let glow = vec4f(glowRgb, src.a * w);

  var out = glow;
  if (maskFlags.hasMask != 0u) {
    let mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    out = glow * mask;
  }
  return out;
}
