// ─── Composite layer over destination ───────────────────────────────────────
//
// Samples the layer texture, decodes it into the document working space
// (per the layer's tagged colour space), then composites with `dst` using
// blend mode + opacity. The decode is **inline** — when a layer is tagged
// with a non-default colour space the renderer binds the matching IDT cube
// + shaper textures and the shader applies the transform during the same
// fragment as the composite. No scratch texture is allocated.

struct CompositeUniforms {
  opacity   : f32,
  blendMode : u32,
  dstRect   : vec4f,    // layer rect in canvas-normalised coords (xy=offset, zw=size)
  hasMask   : u32,
  maskRect  : vec4f,    // mask rect in canvas-normalised coords; sampled at the
                        // dstUV transformed into mask-local UV. Outside [0,1]
                        // → mask treated as 0 (parent hidden).
  /** Inline colour-space transform applied to the sampled layer pixel
   *  before blend math. Set by the renderer based on the layer's tag and
   *  the document working space.
   *    0 — passthrough (source already in working space)
   *    1 — sRGB → linear (analytic, for rgba32f docs with sRGB-tagged data)
   *    2 — camera log → linear (shaper + 3D LUT cube; cube is bound when
   *        this mode is set, identity placeholder otherwise) */
  transformMode : u32,
  /** 3D LUT atlas size (per-axis). Only sampled when transformMode == 2. */
  cubeSize    : f32,
  /** When 1 the optional 1D shaper is consulted before the 3D cube. */
  hasShaper   : u32,
  _pad0       : u32,
}

struct VertexOutput {
  @builtin(position) pos : vec4f,
  @location(0)       uv  : vec2f,
}

@group(0) @binding(0) var imageSampler : sampler;
@group(0) @binding(1) var layerTex     : texture_2d<f32>;
@group(0) @binding(2) var dstTex       : texture_2d<f32>;
@group(0) @binding(3) var maskTex      : texture_2d<f32>;
@group(0) @binding(4) var<uniform> u   : CompositeUniforms;
@group(0) @binding(5) var<uniform> res : vec4f;  // xy=resolution, zw=unused
@group(0) @binding(6) var lutCube      : texture_2d<f32>;
@group(0) @binding(7) var lutShaper    : texture_2d<f32>;
@group(0) @binding(8) var lutSampler   : sampler;

@vertex
fn vs_composite(@location(0) position: vec2f, @location(1) uv: vec2f) -> VertexOutput {
  var out: VertexOutput;
  out.pos = vec4f(
    position.x / res.x * 2.0 - 1.0,
    1.0 - position.y / res.y * 2.0,
    0.0, 1.0
  );
  out.uv = uv;
  return out;
}

fn blendNormal  (s: vec3f, d: vec3f) -> vec3f { return s; }
fn blendMultiply(s: vec3f, d: vec3f) -> vec3f { return s * d; }
fn blendScreen  (s: vec3f, d: vec3f) -> vec3f { return s + d - s * d; }
fn blendOverlay (s: vec3f, d: vec3f) -> vec3f {
  return mix(2.0*s*d, 1.0 - 2.0*(1.0-s)*(1.0-d), step(vec3f(0.5), d));
}
fn blendSoftLight(s: vec3f, d: vec3f) -> vec3f {
  let q = mix(sqrt(d), d, step(vec3f(0.5), s));
  return mix(d - (1.0-2.0*s)*d*(1.0-d), d + (2.0*s-1.0)*(q-d), step(vec3f(0.5), s));
}
fn blendHardLight(s: vec3f, d: vec3f) -> vec3f {
  return mix(2.0*s*d, 1.0 - 2.0*(1.0-s)*(1.0-d), step(vec3f(0.5), s));
}
fn blendDarken  (s: vec3f, d: vec3f) -> vec3f { return min(s, d); }
fn blendLighten (s: vec3f, d: vec3f) -> vec3f { return max(s, d); }
fn blendDiff    (s: vec3f, d: vec3f) -> vec3f { return abs(d - s); }
fn blendExcl    (s: vec3f, d: vec3f) -> vec3f { return s + d - 2.0*s*d; }
fn blendDodge   (s: vec3f, d: vec3f) -> vec3f { return min(d / max(1.0-s, vec3f(0.0001)), vec3f(1.0)); }
fn blendBurn    (s: vec3f, d: vec3f) -> vec3f { return 1.0 - min((1.0-d) / max(s, vec3f(0.0001)), vec3f(1.0)); }

// ─── Inline IDT helpers ─────────────────────────────────────────────────────

fn srgbToLinearChan(c: f32) -> f32 {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}
fn srgbToLinear(c: vec3f) -> vec3f {
  return vec3f(srgbToLinearChan(c.r), srgbToLinearChan(c.g), srgbToLinearChan(c.b));
}

fn sampleShaperChan(t: f32, channel: u32) -> f32 {
  let row = (f32(channel) + 0.5) / 3.0;
  let s = textureSampleLevel(
    lutShaper, lutSampler, vec2f(clamp(t, 0.0, 1.0), row), 0.0,
  );
  return s.r;
}

/** Trilinear sample of the 2D LUT atlas (width=N, height=N²). */
fn sampleCube(rgb: vec3f) -> vec3f {
  let N = u.cubeSize;
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

/** Apply the layer's tagged → working-space transform. */
fn decodeSrc(raw: vec3f) -> vec3f {
  switch (u.transformMode) {
    case 1u: { return srgbToLinear(raw); }
    case 2u: {
      var c = clamp(raw, vec3f(0.0), vec3f(1.0));
      if (u.hasShaper == 1u) {
        c = vec3f(
          sampleShaperChan(c.r, 0u),
          sampleShaperChan(c.g, 1u),
          sampleShaperChan(c.b, 2u),
        );
      }
      return sampleCube(c);
    }
    default: { return raw; }
  }
}

@fragment
fn fs_composite(in: VertexOutput) -> @location(0) vec4f {
  var src = textureSample(layerTex, imageSampler, in.uv);
  // Inline IDT: convert the layer's stored value into the document
  // working space. For default-tagged layers this is a no-op branch.
  src = vec4f(decodeSrc(src.rgb), src.a);
  src.a *= u.opacity;
  let dstUV = u.dstRect.xy + in.uv * u.dstRect.zw;
  if (u.hasMask != 0u) {
    let maskUV = (dstUV - u.maskRect.xy) / u.maskRect.zw;
    let inside = step(vec2f(0.0), maskUV) * step(maskUV, vec2f(1.0));
    let maskVal = textureSample(maskTex, imageSampler, maskUV).r * inside.x * inside.y;
    src.a *= maskVal;
  }
  let dst = textureSample(dstTex, imageSampler, dstUV);
  if (src.a < 0.0001) { return dst; }

  let s = src.rgb;
  var d = dst.rgb;
  if (dst.a > 0.0001) { d = d / dst.a; }

  var blended: vec3f;
  switch (u.blendMode) {
    case 1u:  { blended = blendMultiply(s, d); }
    case 2u:  { blended = blendScreen(s, d); }
    case 3u:  { blended = blendOverlay(s, d); }
    case 4u:  { blended = blendSoftLight(s, d); }
    case 5u:  { blended = blendHardLight(s, d); }
    case 6u:  { blended = blendDarken(s, d); }
    case 7u:  { blended = blendLighten(s, d); }
    case 8u:  { blended = blendDiff(s, d); }
    case 9u:  { blended = blendExcl(s, d); }
    case 10u: { blended = blendDodge(s, d); }
    case 11u: { blended = blendBurn(s, d); }
    default:  { blended = blendNormal(s, d); }
  }

  let outA   = src.a + dst.a * (1.0 - src.a);
  let outRGB = (blended * src.a + d * dst.a * (1.0 - src.a)) / max(outA, 0.0001);
  return vec4f(outRGB, outA);
}
