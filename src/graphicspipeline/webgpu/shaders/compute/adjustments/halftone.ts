export const HALFTONE_COMPUTE = /* wgsl */ `

struct MaskFlags {
  hasMask : u32,
  _pad    : vec3u,
}

struct HalftoneParams {
  frequency : f32,
  offsetC   : f32,
  offsetM   : f32,
  offsetY   : f32,
  offsetK   : f32,
  mode      : u32,
  _pad0     : u32,
  _pad1     : u32,
}

@group(0) @binding(0) var srcTex     : texture_2d<f32>;
@group(0) @binding(1) var dstTex     : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform>   params    : HalftoneParams;
@group(0) @binding(3) var selMask    : texture_2d<f32>;
@group(0) @binding(4) var<uniform>   maskFlags : MaskFlags;

const PI : f32 = 3.14159265358979323846;

const ANG_C : f32 = 105.0;
const ANG_M : f32 = 75.0;
const ANG_Y : f32 = 90.0;
const ANG_K : f32 = 45.0;

fn cmykChannel(sc: vec4f, ch: u32) -> f32 {
  if sc.a < 0.001 { return 0.0; }
  let K = 1.0 - max(sc.r, max(sc.g, sc.b));
  if ch == 3u { return K * sc.a; }
  if K >= 1.0 { return 0.0; }
  let inv = 1.0 / (1.0 - K);
  if ch == 0u { return (1.0 - sc.r - K) * inv * sc.a; }
  if ch == 1u { return (1.0 - sc.g - K) * inv * sc.a; }
  return             (1.0 - sc.b - K) * inv * sc.a;
}

fn screenDot(
  coordf     : vec2f,
  cos_a      : f32,
  sin_a      : f32,
  cell_pitch : f32,
  ch_offset  : f32,
  dims       : vec2u,
  ch         : u32,
) -> f32 {
  let sx = coordf.x * cos_a + coordf.y * sin_a;
  let sy = -coordf.x * sin_a + coordf.y * cos_a;

  let cell_x = floor(sx / cell_pitch);
  let cell_y = floor(sy / cell_pitch);

  let ccsx = (cell_x + 0.5) * cell_pitch;
  let ccsy = (cell_y + 0.5) * cell_pitch;

  let ccx = ccsx * cos_a - ccsy * sin_a;
  let ccy = ccsx * sin_a + ccsy * cos_a;
  let sc = textureLoad(
    srcTex,
    clamp(vec2i(i32(round(ccx)), i32(round(ccy))), vec2i(0), vec2i(dims) - vec2i(1)),
    0,
  );

  let ch_val = cmykChannel(sc, ch);

  let max_r = cell_pitch * 0.5;
  let dot_r = clamp(ch_val * max_r * (1.0 + ch_offset / 100.0), 0.0, max_r);

  let dist = length(vec2f(sx - ccsx, sy - ccsy));

  // Anti-aliased circle via SDF: 1-pixel smooth transition around the edge.
  // step(0.001, dot_r) zeroes out sub-pixel dots that would otherwise leave
  // a faint halo at the cell centre when ch_val ≈ 0.
  let sdf = dist - dot_r;
  return clamp(0.5 - sdf, 0.0, 1.0) * step(0.001, dot_r);
}

@compute @workgroup_size(8, 8)
fn cs_halftone(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(srcTex);
  if id.x >= dims.x || id.y >= dims.y { return; }
  let coord  = vec2i(id.xy);
  let coordf = vec2f(f32(id.x), f32(id.y));

  let cell_pitch = 100.0 / params.frequency;

  var out_color = vec4f(0.0);

  if params.mode == 0u {
    let rad_C = ANG_C * PI / 180.0;
    let rad_M = ANG_M * PI / 180.0;
    let rad_Y = ANG_Y * PI / 180.0;
    let rad_K = ANG_K * PI / 180.0;

    let dotC = screenDot(coordf, cos(rad_C), sin(rad_C), cell_pitch, params.offsetC, dims, 0u);
    let dotM = screenDot(coordf, cos(rad_M), sin(rad_M), cell_pitch, params.offsetM, dims, 1u);
    let dotY = screenDot(coordf, cos(rad_Y), sin(rad_Y), cell_pitch, params.offsetY, dims, 2u);
    let dotK = screenDot(coordf, cos(rad_K), sin(rad_K), cell_pitch, params.offsetK, dims, 3u);

    let R = (1.0 - dotC) * (1.0 - dotK);
    let G = (1.0 - dotM) * (1.0 - dotK);
    let B = (1.0 - dotY) * (1.0 - dotK);
    // Alpha is the maximum ink coverage across all channels so the edge
    // anti-aliasing propagates correctly into the composite.
    let A = max(max(dotC, dotM), max(dotY, dotK));

    out_color = vec4f(R, G, B, A);
  } else {
    let rad_K = ANG_K * PI / 180.0;
    let cos_a = cos(rad_K);
    let sin_a = sin(rad_K);

    let sx = coordf.x * cos_a + coordf.y * sin_a;
    let sy = -coordf.x * sin_a + coordf.y * cos_a;

    let cell_x = floor(sx / cell_pitch);
    let cell_y = floor(sy / cell_pitch);

    let ccsx = (cell_x + 0.5) * cell_pitch;
    let ccsy = (cell_y + 0.5) * cell_pitch;

    let ccx = ccsx * cos_a - ccsy * sin_a;
    let ccy = ccsx * sin_a + ccsy * cos_a;

    let sc = textureLoad(
      srcTex,
      clamp(vec2i(i32(round(ccx)), i32(round(ccy))), vec2i(0), vec2i(dims) - vec2i(1)),
      0,
    );

    let lum = (0.2126 * sc.r + 0.7152 * sc.g + 0.0722 * sc.b) * sc.a;

    let max_r = cell_pitch * 0.5;
    let dot_r = (1.0 - lum) * max_r;

    let dist = length(vec2f(sx - ccsx, sy - ccsy));
    let sdf   = dist - dot_r;
    let alpha = clamp(0.5 - sdf, 0.0, 1.0) * step(0.001, dot_r);
    out_color = vec4f(0.0, 0.0, 0.0, alpha);
  }

  if maskFlags.hasMask != 0u {
    let mask_val = textureLoad(selMask, coord, 0).r;
    let src_color = textureLoad(srcTex, coord, 0);
    out_color = mix(src_color, out_color, mask_val);
  }

  textureStore(dstTex, coord, out_color);
}
`
