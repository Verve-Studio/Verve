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

// DisplaceParams (32 bytes):
//   horizontalScale  f32  (peak displacement in pixels along X)
//   verticalScale    f32  (peak displacement in pixels along Y)
//   noiseFrequency   f32  (cycles across the image's longer side)
//   seed             f32  (any real number; the shader uses its bits to
//                          shift the noise origin so the slider feels
//                          continuous rather than stepped)
//   edgeMode         u32
//   _pad             vec3u
// 5 × 4-byte fields = 20 B; auto-rounded to 32 B. A trailing `vec3u` pad
// would inflate the struct to 48 B and break the encoder's 32-byte UBO.
struct DisplaceParams {
  horizontalScale : f32,
  verticalScale   : f32,
  noiseFrequency  : f32,
  seed            : f32,
  edgeMode        : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : DisplaceParams;
@group(0) @binding(3) var selMask         : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

fn sampleSrc(uv: vec2f, edgeMode: u32) -> vec4f {
  if (edgeMode == 0u) {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      return vec4f(0.0);
    }
  }
  var u = uv;
  if (edgeMode == 2u) {
    u = abs(fract(u * 0.5) * 2.0 - 1.0);
  } else {
    u = clamp(u, vec2f(0.0), vec2f(1.0));
  }
  let dimsU = textureDimensions(srcTex);
  let dims  = vec2f(f32(dimsU.x), f32(dimsU.y));
  let pix   = u * dims - vec2f(0.5);
  let p0    = floor(pix);
  let f     = pix - p0;
  let c00   = vec2i(p0);
  let dimsI = vec2i(dimsU);
  let mn    = vec2i(0, 0);
  let mx    = dimsI - vec2i(1, 1);
  let s00 = textureLoad(srcTex, clamp(c00,                  mn, mx), 0);
  let s10 = textureLoad(srcTex, clamp(c00 + vec2i(1, 0),    mn, mx), 0);
  let s01 = textureLoad(srcTex, clamp(c00 + vec2i(0, 1),    mn, mx), 0);
  let s11 = textureLoad(srcTex, clamp(c00 + vec2i(1, 1),    mn, mx), 0);
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

// ── Value-noise displacement source ──────────────────────────────────────────
// Cheap-but-smooth procedural noise. We sample two independent octaves at
// staggered offsets so the X and Y displacement channels look uncorrelated
// (otherwise the displacement is purely diagonal, which tends to look bad).

fn hash21(p: vec2f) -> f32 {
  let h = sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453;
  return fract(h);
}

fn smoothNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (vec2f(3.0) - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

@fragment
fn fs_displace(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dimsU = textureDimensions(srcTex);
  let dims  = vec2f(f32(dimsU.x), f32(dimsU.y));
  let pix   = in.uv * dims;

  // Frequency in cycles across the canvas; use the longer side as anchor so
  // the noise looks similar regardless of aspect ratio.
  let scaleSide = max(dims.x, dims.y);
  let np = in.uv * vec2f(dims.x, dims.y) / scaleSide * params.noiseFrequency;

  // Two decorrelated noise samples: shifted seeds give independent X / Y.
  let s = params.seed;
  let nx = smoothNoise(np + vec2f(s,        s + 11.3));
  let ny = smoothNoise(np + vec2f(s + 47.1, s + 91.7));

  let displaced = pix - vec2f(nx * params.horizontalScale,
                              ny * params.verticalScale);
  let src_uv    = displaced / dims;

  let result = sampleSrc(src_uv, params.edgeMode);
  if (maskFlags.hasMask != 0u) {
    let src_orig = textureLoad(srcTex, vec2i(i32(in.pos.x), i32(in.pos.y)), 0);
    let mask     = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    return mix(src_orig, result, mask);
  }
  return result;
}
