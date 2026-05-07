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


// LensDistParams (32 bytes):
//   distType  : u32  (0 = radial, 1 = fisheye, 2 = mustache, 3 = perspective)
//   edgeMode  : u32  (0 = transparent, 1 = clamp, 2 = mirror)
//   _pad0     : vec2u
//   strength  : f32  (−1 .. 1, primary distortion coefficient)
//   secondary : f32  (−1 .. 1, mustache 4th-order term)
//   centerX   : f32  (0 .. 1)
//   centerY   : f32  (0 .. 1)
//   zoom      : f32  (post-distortion scale, 1.0 = no zoom)
//   tiltX     : f32  (−1 .. 1, perspective tilt around vertical axis)
//   tiltY     : f32  (−1 .. 1, perspective tilt around horizontal axis)
//   _pad1     : f32
struct LensDistParams {
  distType  : u32,
  edgeMode  : u32,
  _pad0     : vec2u,
  strength  : f32,
  secondary : f32,
  centerX   : f32,
  centerY   : f32,
  zoom      : f32,
  tiltX     : f32,
  tiltY     : f32,
  _pad1     : f32,
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var smp      : sampler;
@group(0) @binding(2) var<uniform> params    : LensDistParams;
@group(0) @binding(3) var selMask  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

// Manual bilinear sample with explicit edge handling. We avoid textureSample
// because the source can be rgba32float (which only supports `unfilterable-float`
// without an extra device feature), and the filtering sampler bound to slot 1
// is already configured as non-filtering for the standard adjustment path.
fn sampleSrc(uv: vec2f, edgeMode: u32) -> vec4f {
  if (edgeMode == 0u) {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      return vec4f(0.0);
    }
  }
  var u = uv;
  if (edgeMode == 2u) {
    // Mirror: triangle wave on each axis maps any value to [0,1].
    u = abs(fract(u * 0.5) * 2.0 - 1.0);
  } else {
    // Transparent path already early-outed; clamp path lands here.
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
  let x0 = mix(s00, s10, f.x);
  let x1 = mix(s01, s11, f.x);
  return mix(x0, x1, f.y);
}

@fragment
fn fs_lens_distortion(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dimsU  = textureDimensions(srcTex);
  let dims   = vec2f(f32(dimsU.x), f32(dimsU.y));
  let aspect = dims.x / max(dims.y, 1.0);
  let center = vec2f(params.centerX, params.centerY);
  let zoom   = max(params.zoom, 0.05);

  // Aspect-correct the centred coords so radial math is symmetric on
  // non-square images. We undo this scaling before sampling.
  let p_pix  = (in.uv - center) * vec2f(aspect, 1.0);
  let r      = length(p_pix);

  var src_uv : vec2f;

  if (params.distType == 3u) {
    // ── Perspective: simple keystone via projective denominators ──────────────
    // tiltX makes top wider/narrower than bottom (yaw), tiltY does the same
    // along the orthogonal axis. Cheap but visually convincing for a
    // wide-angle lens tilt or a horizon-correction warp.
    let pp     = in.uv - center;
    let denomX = 1.0 + params.tiltX * pp.y;
    let denomY = 1.0 + params.tiltY * pp.x;
    let new_p  = vec2f(pp.x / max(denomX, 0.05),
                       pp.y / max(denomY, 0.05));
    src_uv     = new_p / zoom + center;
  } else {
    var factor = 1.0;
    if (params.distType == 0u) {
      // Standard radial: factor = 1 + k·r². Positive k → barrel
      // (output centre samples from further out → image bulges outward),
      // negative k → pincushion (image compresses toward centre).
      factor = 1.0 + params.strength * r * r;
    } else if (params.distType == 1u) {
      // Fisheye (equidistant projection): src_radius = atan(r·fov)/fov.
      // Stronger `strength` widens the simulated field of view.
      let fov = max(abs(params.strength) * 2.0, 0.01);
      if (r > 1e-4) {
        factor = atan(r * fov) / (r * fov);
      }
    } else if (params.distType == 2u) {
      // Mustache: 1 + k1·r² + k2·r⁴. Combining opposite-sign terms produces
      // the "wave" warp seen in real cheap wide-angle lenses.
      let r2 = r * r;
      factor = 1.0 + params.strength * r2 + params.secondary * r2 * r2;
    }
    let new_p = p_pix * factor;
    // Undo aspect correction so we sample in proper UV space.
    src_uv = new_p * vec2f(1.0 / aspect, 1.0) / zoom + center;
  }

  let result = sampleSrc(src_uv, params.edgeMode);

  if (maskFlags.hasMask != 0u) {
    let src_orig = textureLoad(srcTex, vec2i(i32(in.pos.x), i32(in.pos.y)), 0);
    let mask     = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    return mix(src_orig, result, mask);
  }
  return result;
}
