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

struct NeonGlowParams {
  glowSize     : f32,   // -24..24
  glowBrightness: f32,  // 0..50
  glowR        : f32,
  glowG        : f32,
  glowB        : f32,
  _pad0        : f32,
  _pad1        : f32,
  _pad2        : f32,
}

@group(0) @binding(0) var srcTex     : texture_2d<f32>;
@group(0) @binding(1) var smp        : sampler;
@group(0) @binding(2) var<uniform>   params    : NeonGlowParams;
@group(0) @binding(3) var selMask    : texture_2d<f32>;
@group(0) @binding(4) var<uniform>   maskFlags : MaskFlags;

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }

@fragment
fn fs_neon_glow(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims = vec2i(textureDimensions(srcTex));
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let src = textureLoad(srcTex, coord, 0);

  let inputIsLinear = maskFlags.inputIsLinear != 0u;
  let srcP = select(src.rgb, srgbEncode(src.rgb), inputIsLinear);

  // Sample a local-mean luma in a small kernel — produces the soft
  // "neon spread" between midtones. Glow size is signed: positive
  // expands the glow into bright areas, negative pulls it toward dark.
  let r = i32(round(abs(params.glowSize) * 0.5));
  var sumL = 0.0;
  var count = 0.0;
  for (var dy = -r; dy <= r; dy = dy + 1) {
    for (var dx = -r; dx <= r; dx = dx + 1) {
      let c = clamp(coord + vec2i(dx, dy), vec2i(0), dims - vec2i(1));
      let s = textureLoad(srcTex, c, 0).rgb;
      let sP = select(s, srgbEncode(s), inputIsLinear);
      sumL = sumL + luma(sP);
      count = count + 1.0;
    }
  }
  let avgL = sumL / max(count, 1.0);
  let centerL = luma(srcP);

  // Mix between centre and blurred luma; negative glowSize biases toward
  // the centre (sharper neon), positive biases toward the blurred
  // surround (soft bloom).
  let spreadBias = (params.glowSize + 24.0) / 48.0;
  let l = mix(centerL, avgL, spreadBias);

  // S-curve ramp through three colour stops: black (shadows) → glow
  // colour (midtones) → white (highlights). Brightness 0..50 scales the
  // overall intensity.
  let glow = vec3f(params.glowR, params.glowG, params.glowB);
  let bright = params.glowBrightness * 0.02; // 0..1
  let lLow = smoothstep(0.0, 0.5, l);
  let lHigh = smoothstep(0.5, 1.0, l);
  var out = mix(vec3f(0.0), glow, lLow);
  out = mix(out, vec3f(1.0), lHigh);
  out = out * (0.5 + bright);

  let outRgb = select(out, srgbDecode(out), inputIsLinear);
  let result = vec4f(outRgb, src.a);
  if (maskFlags.hasMask != 0u) {
    let m = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    return mix(src, result, m);
  }
  return result;
}
