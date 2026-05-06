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

// PolarParams (32 bytes):
//   mode      u32 (0 = rect→polar, 1 = polar→rect)
//   centerX   f32
//   centerY   f32
//   edgeMode  u32
//   _pad      vec4u
// 4 × 4-byte fields = 16 B; the WGSL uniform alignment rule rounds struct
// size up to a 16-byte multiple, so this is naturally 16 B. Encoder writes
// a 32-byte UBO which the pipeline accepts.
struct PolarParams {
  mode     : u32,
  centerX  : f32,
  centerY  : f32,
  edgeMode : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var<uniform> params : PolarParams;
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

const PI : f32 = 3.14159265358979;

@fragment
fn fs_polar(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dimsU  = textureDimensions(srcTex);
  let dims   = vec2f(f32(dimsU.x), f32(dimsU.y));
  let aspect = dims.x / max(dims.y, 1.0);
  let center = vec2f(params.centerX, params.centerY);

  var src_uv : vec2f;

  if (params.mode == 0u) {
    // Rect → Polar:
    // Output (x, y) is interpreted as (theta, radius). Reading position
    // amounts to: turn output into a polar coord and sample the source
    // at the matching cartesian point.
    let nx = (in.uv.x - 0.5) * 2.0;          // −1..1, full width
    let ny = in.uv.y;                         // 0 = top, 1 = bottom
    let theta = nx * PI;                      // wrap full circle across width
    let r     = ny;                           // distance from center, 0..1
    let p     = vec2f(sin(theta), -cos(theta)) * r * 0.5;
    src_uv    = p * vec2f(1.0 / aspect, 1.0) + center;
  } else {
    // Polar → Rect:
    // Output (x, y) is treated as cartesian; we measure its angle and
    // radius and remap into the rect-source's (theta, radius) layout.
    let p     = (in.uv - center) * vec2f(aspect, 1.0);
    let r     = length(p) * 2.0;
    let theta = atan2(p.x, -p.y);             // 0 = up, increases clockwise
    let nx    = theta / PI;                    // −1..1
    let ny    = clamp(r, 0.0, 1.0);
    src_uv    = vec2f(nx * 0.5 + 0.5, ny);
  }

  let result = sampleSrc(src_uv, params.edgeMode);
  if (maskFlags.hasMask != 0u) {
    let src_orig = textureLoad(srcTex, vec2i(i32(in.pos.x), i32(in.pos.y)), 0);
    let mask     = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    return mix(src_orig, result, mask);
  }
  return result;
}
