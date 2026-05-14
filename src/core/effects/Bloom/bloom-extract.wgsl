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



struct BloomExtractParams {
  threshold     : f32,
  inputIsLinear : f32,
  _pad1         : f32,
  _pad2         : f32,
}

@group(0) @binding(0) var srcTex     : texture_2d<f32>;
@group(0) @binding(1) var smp        : sampler;
@group(0) @binding(2) var<uniform> params    : BloomExtractParams;
@group(0) @binding(3) var selMask    : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

// sRGB transfer helpers — used to evaluate the bloom threshold in
// perceptual space regardless of doc format. Without this, an rgba32f doc's
// scene-linear src values get crushed below 0.5 so the same threshold
// captures vastly more (or fewer) pixels than in an rgba8 doc.
fn srgbEncodeF(c: f32) -> f32 {
  let x = max(c, 0.0);
  return select(1.055 * pow(x, 1.0 / 2.4) - 0.055, x * 12.92, x <= 0.0031308);
}
fn srgbEncode(rgb: vec3f) -> vec3f {
  return vec3f(srgbEncodeF(rgb.r), srgbEncodeF(rgb.g), srgbEncodeF(rgb.b));
}

@fragment
fn fs_bloom_extract(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);
  let inputIsLinear = params.inputIsLinear > 0.5;

  // Threshold against perceptual luminance — the user-facing `threshold`
  // slider is calibrated for 0..1 perceptual brightness.
  let percRgb = select(src.rgb, srgbEncode(src.rgb), inputIsLinear);
  let lum = dot(percRgb, vec3f(0.2126, 0.7152, 0.0722));
  let t   = params.threshold;
  let k   = 0.1;
  let w   = smoothstep(t - k, t + k, lum);

  // Emit the glow in the same colour space as the source so the downstream
  // blur + composite math stays in one space end-to-end.
  let glow = vec4f(src.rgb * w, src.a * w);

  var out = glow;
  if (maskFlags.hasMask != 0u) {
    let mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    out = glow * mask;
  }
  return out;
}
