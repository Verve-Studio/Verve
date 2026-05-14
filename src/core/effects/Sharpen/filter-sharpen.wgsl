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

struct SharpenParams {
  // Flat u32 padding instead of `vec3u`: the latter has alignment 16 and
  // forces the struct size up to 32 bytes, but the encoder allocates a
  // 16-byte uniform buffer. Using three scalar u32s keeps the WGSL struct
  // size at 16 bytes so the binding-size check passes.
  inputIsLinear : u32,
  _pad0         : u32,
  _pad1         : u32,
  _pad2         : u32,
}

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var smp    : sampler;
@group(0) @binding(2) var<uniform> params : SharpenParams;

// The 3×3 sharpen kernel (centre +5, neighbours -1) was tuned for 0–1
// perceptual values. On scene-linear floats the same coefficients amplify
// linear differences which look much harsher on display. Run the kernel in
// perceptual space to keep the visible sharpness consistent.
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

const kernel = array<f32, 9>(
   0.0, -1.0,  0.0,
  -1.0,  5.0, -1.0,
   0.0, -1.0,  0.0,
);

@fragment
fn fs_sharpen(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let inputIsLinear = params.inputIsLinear != 0u;

  var rgbSum = vec3f(0.0);
  for (var ky = -1; ky <= 1; ky++) {
    for (var kx = -1; kx <= 1; kx++) {
      let sx = clamp(coord.x + kx, 0, i32(dims.x) - 1);
      let sy = clamp(coord.y + ky, 0, i32(dims.y) - 1);
      let k  = kernel[(ky + 1) * 3 + (kx + 1)];
      let s  = textureLoad(srcTex, vec2i(sx, sy), 0).rgb;
      let sP = select(s, srgbEncode(s), inputIsLinear);
      rgbSum += sP * k;
    }
  }
  let orig = textureLoad(srcTex, coord, 0);
  let outP = clamp(rgbSum, vec3f(0.0), vec3f(1.0));
  let outRgb = select(outP, srgbDecode(outP), inputIsLinear);
  return vec4f(outRgb, orig.a);
}
