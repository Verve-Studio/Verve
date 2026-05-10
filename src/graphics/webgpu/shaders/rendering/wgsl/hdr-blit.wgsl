struct BlitRes {
  resolution  : vec2f,
  _pad        : vec2f,
}

struct ToneMappingUniforms {
  exposureLinear : f32,   // pow(2.0, exposureEV)
  isFp32         : f32,   // 1.0 if rgba32f document, 0.0 otherwise
  tm_operator    : u32,   // 1 = Reinhard, 0 = clamp only
  _pad           : f32,
}

struct VertexOutput {
  @builtin(position) pos : vec4f,
  @location(0)       uv  : vec2f,
}

@group(0) @binding(0) var blitSampler : sampler;
@group(0) @binding(1) var srcTex      : texture_2d<f32>;
@group(0) @binding(2) var<uniform> u  : BlitRes;
@group(0) @binding(3) var<uniform> tm : ToneMappingUniforms;

@vertex
fn vs_blit(@location(0) position: vec2f, @location(1) uv: vec2f) -> VertexOutput {
  var out: VertexOutput;
  out.pos = vec4f(
    position.x / u.resolution.x * 2.0 - 1.0,
    1.0 - position.y / u.resolution.y * 2.0,
    0.0, 1.0
  );
  out.uv = uv;
  return out;
}

fn tm_reinhard(c: vec3f) -> vec3f {
  return c / (c + vec3f(1.0));
}

// Linear-light → sRGB transfer (per-channel). Mirrors the JS
// `linearToSrgbChannel` used by `pixelFormatConvert.ts`.
fn linearToSrgb(c: vec3f) -> vec3f {
  let cutoff = vec3f(0.0031308);
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= cutoff);
}

@fragment
fn fs_blit(in: VertexOutput) -> @location(0) vec4f {
  let sample = textureSample(srcTex, blitSampler, in.uv);
  if (tm.isFp32 < 0.5) {
    // rgba8 documents already sit in sRGB-encoded display space. The
    // composite intermediate kept their values unchanged, so pass through.
    return sample;
  }
  // rgba32f documents are linear-light. Apply exposure + tone-map, then
  // gamma-encode to sRGB so the swap-chain (sRGB-display) shows the
  // correct perceptual brightness.
  let scaled = sample.rgb * tm.exposureLinear;
  var mapped: vec3f;
  if (tm.tm_operator == 1u) {
    mapped = tm_reinhard(scaled);
  } else {
    mapped = clamp(scaled, vec3f(0.0), vec3f(1.0));
  }
  let encoded = linearToSrgb(clamp(mapped, vec3f(0.0), vec3f(1.0)));
  return vec4f(encoded, sample.a);
}
