struct BlitRes {
  resolution  : vec2f,
  _pad        : vec2f,
}

struct ToneMappingUniforms {
  exposureLinear : f32,   // pow(2.0, exposureEV)
  isFp32         : f32,   // 1.0 if rgba32f document, 0.0 otherwise
  tm_operator    : u32,   // 1 = Reinhard, 0 = clamp only
  hasViewLut     : u32,   // 1 if a canvas-only view-transform LUT is active
  cubeSize       : f32,   // 3D LUT per-axis (e.g. 33)
  lutInSpace     : u32,   // 0 = sRGB-encoded, 1 = linear-light
  lutOutSpace    : u32,
  hasShaper      : u32,   // 1 if a 1D shaper is bound
}

struct VertexOutput {
  @builtin(position) pos : vec4f,
  @location(0)       uv  : vec2f,
}

@group(0) @binding(0) var blitSampler : sampler;
@group(0) @binding(1) var srcTex      : texture_2d<f32>;
@group(0) @binding(2) var<uniform> u  : BlitRes;
@group(0) @binding(3) var<uniform> tm : ToneMappingUniforms;
@group(0) @binding(4) var lutCube     : texture_2d<f32>;
@group(0) @binding(5) var lutShaper   : texture_2d<f32>;
@group(0) @binding(6) var lutSampler  : sampler;

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

fn srgbToLinearChan(c: f32) -> f32 {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}
fn linearToSrgbChan(c: f32) -> f32 {
  if (c <= 0.0) { return 0.0; }
  if (c <= 0.0031308) { return c * 12.92; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
fn linearToSrgb(c: vec3f) -> vec3f {
  return vec3f(linearToSrgbChan(c.r), linearToSrgbChan(c.g), linearToSrgbChan(c.b));
}
fn srgbToLinear(c: vec3f) -> vec3f {
  return vec3f(srgbToLinearChan(c.r), srgbToLinearChan(c.g), srgbToLinearChan(c.b));
}

fn convertSpace(c: vec3f, fromSpace: u32, toSpace: u32) -> vec3f {
  if (fromSpace == toSpace) { return c; }
  if (fromSpace == 0u && toSpace == 1u) { return srgbToLinear(c); }
  if (fromSpace == 1u && toSpace == 0u) { return linearToSrgb(clamp(c, vec3f(0.0), vec3f(1.0))); }
  return c;
}

fn sampleShaper(t: f32, channel: u32) -> f32 {
  let row = (f32(channel) + 0.5) / 3.0;
  let s = textureSampleLevel(lutShaper, lutSampler, vec2f(clamp(t, 0.0, 1.0), row), 0.0);
  return s.r;
}

fn sampleCube(rgb: vec3f) -> vec3f {
  let N = tm.cubeSize;
  let c = clamp(rgb, vec3f(0.0), vec3f(1.0));
  let pf = c * (N - 1.0);
  let bi0 = floor(pf.b);
  let bi1 = min(bi0 + 1.0, N - 1.0);
  let bt  = pf.b - bi0;
  let atlasW = N;
  let atlasH = N * N;
  let xs  = (pf.r + 0.5) / atlasW;
  let ys0 = (bi0 * N + pf.g + 0.5) / atlasH;
  let ys1 = (bi1 * N + pf.g + 0.5) / atlasH;
  let s0 = textureSampleLevel(lutCube, lutSampler, vec2f(xs, ys0), 0.0).rgb;
  let s1 = textureSampleLevel(lutCube, lutSampler, vec2f(xs, ys1), 0.0).rgb;
  return mix(s0, s1, bt);
}

@fragment
fn fs_blit(in: VertexOutput) -> @location(0) vec4f {
  let sample = textureSample(srcTex, blitSampler, in.uv);
  // Stage 1: produce an sRGB-encoded display value.
  //
  //   - rgba8 doc: source is already sRGB-encoded; pass through.
  //   - rgba32f doc: source is linear-light; apply exposure, optional
  //     tone-map, then sRGB encode.
  var displayRgb: vec3f;
  if (tm.isFp32 < 0.5) {
    displayRgb = sample.rgb;
  } else {
    let scaled = sample.rgb * tm.exposureLinear;
    var mapped: vec3f;
    if (tm.tm_operator == 1u) {
      mapped = tm_reinhard(scaled);
    } else {
      mapped = clamp(scaled, vec3f(0.0), vec3f(1.0));
    }
    displayRgb = linearToSrgb(clamp(mapped, vec3f(0.0), vec3f(1.0)));
  }

  // Stage 2: optional canvas-only view-transform LUT. Convert the sRGB-
  // encoded display value into the LUT's input space, apply shaper + cube,
  // and convert back to sRGB for the swap chain.
  if (tm.hasViewLut == 1u) {
    var c = convertSpace(displayRgb, 0u, tm.lutInSpace);
    if (tm.hasShaper == 1u) {
      c = vec3f(sampleShaper(c.r, 0u), sampleShaper(c.g, 1u), sampleShaper(c.b, 2u));
    }
    c = sampleCube(c);
    displayRgb = convertSpace(c, tm.lutOutSpace, 0u);
  }

  return vec4f(displayRgb, sample.a);
}
