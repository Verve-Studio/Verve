struct CompositeUniforms {
  opacity   : f32,
  blendMode : u32,
  dstRect   : vec4f,    // layer rect in canvas-normalised coords (xy=offset, zw=size)
  hasMask   : u32,
  maskRect  : vec4f,    // mask rect in canvas-normalised coords; sampled at the
                        // dstUV transformed into mask-local UV. Outside [0,1]
                        // → mask treated as 0 (parent hidden).
}

struct VertexOutput {
  @builtin(position) pos : vec4f,
  @location(0)       uv  : vec2f,
}

@group(0) @binding(0) var imageSampler : sampler;
@group(0) @binding(1) var layerTex    : texture_2d<f32>;
@group(0) @binding(2) var dstTex      : texture_2d<f32>;
@group(0) @binding(3) var maskTex     : texture_2d<f32>;
@group(0) @binding(4) var<uniform> u  : CompositeUniforms;
@group(0) @binding(5) var<uniform> res : vec4f;  // xy=resolution, zw=unused

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

@fragment
fn fs_composite(in: VertexOutput) -> @location(0) vec4f {
  var src = textureSample(layerTex, imageSampler, in.uv);
  src.a *= u.opacity;
  let dstUV = u.dstRect.xy + in.uv * u.dstRect.zw;
  if (u.hasMask != 0u) {
    // Transform the canvas-space dstUV into mask-local UV. Mask buffer
    // covers `maskRect` in canvas-normalised coords; outside that rect
    // the mask is treated as 0 (parent fully hidden).
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
