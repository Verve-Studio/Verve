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

struct UnsharpParams {
  amount        : u32,
  threshold     : u32,
  inputIsLinear : u32,
  _pad1         : u32,
}

@group(0) @binding(0) var origTex             : texture_2d<f32>;
@group(0) @binding(1) var smp                 : sampler;
@group(0) @binding(2) var blurredTex          : texture_2d<f32>;
@group(0) @binding(3) var<uniform> params     : UnsharpParams;

// The 0–255 threshold slider and the additive sharpening amount were
// calibrated for sRGB-encoded pixels. On scene-linear floats the threshold
// catches a wholly different population of pixels and the added high-pass
// detail is much harsher because linear deltas are smaller. Run the
// detail math in perceptual space to keep the look stable.
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

@fragment
fn fs_unsharp_combine(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord   = vec2i(i32(in.pos.x), i32(in.pos.y));
  let orig    = textureLoad(origTex,    coord, 0);
  let blurred = textureLoad(blurredTex, coord, 0);

  let inputIsLinear = params.inputIsLinear != 0u;
  let origP    = select(orig.rgb,    srgbEncode(orig.rgb),    inputIsLinear);
  let blurredP = select(blurred.rgb, srgbEncode(blurred.rgb), inputIsLinear);

  let scale = f32(params.amount) / 100.0;
  let thr   = f32(params.threshold) / 255.0;

  let dRgb = origP - blurredP;
  let lumaDiff = abs(0.299 * dRgb.r + 0.587 * dRgb.g + 0.114 * dRgb.b);

  if (lumaDiff > thr) {
    let sharpP = clamp(origP + scale * dRgb, vec3f(0.0), vec3f(1.0));
    let outRgb = select(sharpP, srgbDecode(sharpP), inputIsLinear);
    return vec4f(outRgb, orig.a);
  }
  return vec4f(orig.rgb, orig.a);
}
