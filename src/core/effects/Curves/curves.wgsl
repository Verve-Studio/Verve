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


@group(0) @binding(0) var srcTex    : texture_2d<f32>;
@group(0) @binding(1) var smp       : sampler;
@group(0) @binding(2) var selMask   : texture_2d<f32>;
@group(0) @binding(3) var<uniform> maskFlags  : MaskFlags;
// binding 4 (a filtering sampler) is no longer used: the r32float LUTs are
// read with textureLoad and interpolated by hand.
@group(0) @binding(5) var rgbLut    : texture_2d<f32>;
@group(0) @binding(6) var redLut    : texture_2d<f32>;
@group(0) @binding(7) var greenLut  : texture_2d<f32>;
@group(0) @binding(8) var blueLut   : texture_2d<f32>;

// The curve LUTs were authored on the 0..1 perceptual scale (the on-screen
// "0–255" graph the user drags). On scene-linear floats the same input
// value lands at a very different position along the curve, so the LUT
// reshapes the wrong tonal region. Bridge through sRGB so the curve hits
// the same perceptual values in either pixel format.
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

// Entry i is the output for input i/255: interpolate between texel centres
// (input i/255 hits entry i exactly, so the identity curve is exact).
// Inputs above 1 (HDR) continue along the curve's end slope instead of
// clipping.
fn sampleLut(lut: texture_2d<f32>, channelValue: f32) -> f32 {
  let last = textureLoad(lut, vec2i(255, 0), 0).r;
  if (channelValue > 1.0) {
    let slope = (last - textureLoad(lut, vec2i(254, 0), 0).r) * 255.0;
    return last + (channelValue - 1.0) * slope;
  }
  let x  = clamp(channelValue, 0.0, 1.0) * 255.0;
  let i0 = min(u32(x), 254u);
  let t  = x - f32(i0);
  let a  = textureLoad(lut, vec2i(i32(i0), 0), 0).r;
  let b  = textureLoad(lut, vec2i(i32(i0) + 1, 0), 0).r;
  return mix(a, b, t);
}

@fragment
fn fs_curves(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);
  if (src.a < 0.0001) { return src; }

  let inputIsLinear = maskFlags.inputIsLinear != 0u;
  let inP = select(src.rgb, srgbEncode(src.rgb), inputIsLinear);

  let rgb1 = vec3f(
    sampleLut(rgbLut, inP.r),
    sampleLut(rgbLut, inP.g),
    sampleLut(rgbLut, inP.b),
  );
  let outP = vec3f(
    sampleLut(redLut,   rgb1.r),
    sampleLut(greenLut, rgb1.g),
    sampleLut(blueLut,  rgb1.b),
  );
  let outRgb = select(outP, srgbDecode(outP), inputIsLinear);
  let adjusted = vec4f(outRgb, src.a);

  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return mix(src, adjusted, mask);
}
