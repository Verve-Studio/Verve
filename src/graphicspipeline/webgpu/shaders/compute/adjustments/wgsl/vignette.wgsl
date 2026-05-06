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

struct VignetteParams {
  // 0 = ellipse, 1 = rectangle (super-ellipse controlled by roundness)
  shape     : u32,
  spread    : f32,   // 0..1: where the falloff begins (0 = at centre, 1 = at corner)
  softness  : f32,   // 0..1: width of the falloff band
  opacity   : f32,   // 0..1: overall vignette overlay opacity
  color     : vec3f, // 0..1 sRGB
  roundness : f32,   // 0 = sharp rectangle, 1 = ellipse (only for shape == 1)
}

@group(0) @binding(0) var srcTex     : texture_2d<f32>;
@group(0) @binding(1) var smp        : sampler;
@group(0) @binding(2) var<uniform> params    : VignetteParams;
@group(0) @binding(3) var selMask    : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

@fragment
fn fs_vignette(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims  = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let src   = textureLoad(srcTex, coord, 0);

  // Centred coordinate in [-1, 1] across each axis, scaled to preserve aspect.
  let size  = vec2f(f32(dims.x), f32(dims.y));
  let p     = (vec2f(f32(coord.x), f32(coord.y)) + vec2f(0.5)) / size;
  let aspect = size.x / size.y;
  var c = (p - vec2f(0.5)) * 2.0;
  if (aspect >= 1.0) {
    c.x = c.x * aspect;
  } else {
    c.y = c.y / aspect;
  }
  // c is now in a unit-square-ish space; corner length = sqrt(aspect^2 + 1) for landscape.
  // Normalise so corner sits at distance 1.0 for the ellipse path.
  let cornerLen = length(vec2f(select(1.0, aspect, aspect >= 1.0),
                               select(1.0 / aspect, 1.0, aspect >= 1.0)));
  let cn = c / cornerLen;

  var d : f32;
  if (params.shape == 0u) {
    // Ellipse — radial distance, 0 at centre, 1 at corner.
    d = length(cn);
  } else {
    // Super-ellipse: |x|^n + |y|^n = 1.
    // roundness: 1 → n = 2 (ellipse), 0 → n = 16 (near-rectangle).
    let n = mix(16.0, 2.0, clamp(params.roundness, 0.0, 1.0));
    let q = abs(cn);
    d = pow(pow(q.x, n) + pow(q.y, n), 1.0 / n);
  }

  // Falloff: 0 inside the spread radius, ramping to 1 across the softness band.
  let inner = clamp(params.spread, 0.0, 1.0);
  let outer = min(inner + max(params.softness, 0.0001), 1.5);
  let t     = clamp((d - inner) / max(outer - inner, 1e-4), 0.0, 1.0);
  let falloff = t * t * (3.0 - 2.0 * t); // smoothstep

  var alpha = falloff * clamp(params.opacity, 0.0, 1.0);

  if (maskFlags.hasMask != 0u) {
    let mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    alpha = alpha * mask;
  }

  // Composite the vignette colour over the source. Alpha is preserved.
  let outRgb = mix(src.rgb, params.color, alpha);
  return vec4f(outRgb, src.a);
}
