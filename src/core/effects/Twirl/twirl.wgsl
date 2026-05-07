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

// TwirlParams (32 bytes):
//   angleRad  f32  (peak rotation, radians)
//   centerX   f32
//   centerY   f32
//   radius    f32  (0..1 fraction of half-diagonal)
//   edgeMode  u32
//   _pad      vec3u
// 5 × 4-byte fields = 20 B; auto-rounded to 32 B. Trailing `vec3u` pad
// would force struct alignment to 16 and bump the size to 48 — DON'T add it.
struct TwirlParams {
  angleRad : f32,
  centerX  : f32,
  centerY  : f32,
  radius   : f32,
  edgeMode : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : TwirlParams;
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

@fragment
fn fs_twirl(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dimsU  = textureDimensions(srcTex);
  let dims   = vec2f(f32(dimsU.x), f32(dimsU.y));
  let aspect = dims.x / max(dims.y, 1.0);
  let center = vec2f(params.centerX, params.centerY);
  let radius = max(params.radius, 1e-3);

  let p = (in.uv - center) * vec2f(aspect, 1.0);
  let r = length(p) / radius;

  var src_uv = in.uv;
  if (r < 1.0) {
    // Quadratic falloff so rotation is strongest at the centre and tapers
    // smoothly to zero at the radius boundary.
    let t      = (1.0 - r) * (1.0 - r);
    let theta  = params.angleRad * t;
    let cosT   = cos(theta);
    let sinT   = sin(theta);
    // Inverse mapping: rotate output point backward to find the source.
    let new_p  = vec2f(p.x * cosT - p.y * sinT,
                       p.x * sinT + p.y * cosT);
    src_uv     = new_p * vec2f(1.0 / aspect, 1.0) + center;
  }

  let result = sampleSrc(src_uv, params.edgeMode);
  if (maskFlags.hasMask != 0u) {
    let src_orig = textureLoad(srcTex, vec2i(i32(in.pos.x), i32(in.pos.y)), 0);
    let mask     = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    return mix(src_orig, result, mask);
  }
  return result;
}
