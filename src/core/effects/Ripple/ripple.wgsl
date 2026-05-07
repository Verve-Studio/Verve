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

// RippleParams (32 bytes):
//   amount       f32  (peak displacement in pixels)
//   wavelengthPx f32  (one full sine cycle in pixels)
//   direction    u32  (0 horizontal, 1 vertical, 2 both)
//   edgeMode     u32
//   _pad         vec4u
// 4 × 4-byte fields = 16 B; auto-rounded to 16-byte struct size.
struct RippleParams {
  amount       : f32,
  wavelengthPx : f32,
  direction    : u32,
  edgeMode     : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : RippleParams;
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

const TAU : f32 = 6.28318530718;

@fragment
fn fs_ripple(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dimsU = textureDimensions(srcTex);
  let dims  = vec2f(f32(dimsU.x), f32(dimsU.y));
  let pix   = in.uv * dims;

  let lambda = max(params.wavelengthPx, 1.0);
  let A      = params.amount;

  // Ripple: a horizontal ripple displaces X based on Y position (and vice
  // versa). `both` emits a cross-pattern that gives the classic Photoshop
  // Ripple look.
  var dx = 0.0;
  var dy = 0.0;
  if (params.direction == 0u) {
    dx = sin(pix.y * TAU / lambda) * A;
  } else if (params.direction == 1u) {
    dy = sin(pix.x * TAU / lambda) * A;
  } else {
    dx = sin(pix.y * TAU / lambda) * A;
    dy = sin(pix.x * TAU / lambda) * A;
  }

  let src_pix = pix - vec2f(dx, dy);
  let src_uv  = src_pix / dims;

  let result = sampleSrc(src_uv, params.edgeMode);
  if (maskFlags.hasMask != 0u) {
    let src_orig = textureLoad(srcTex, vec2i(i32(in.pos.x), i32(in.pos.y)), 0);
    let mask     = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    return mix(src_orig, result, mask);
  }
  return result;
}
