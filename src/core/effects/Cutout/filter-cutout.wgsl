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

struct CutoutParams {
  levels       : f32,
  edgeSimplicity: f32,
  edgeFidelity : f32,
  _pad         : f32,
}

@group(0) @binding(0) var srcTex     : texture_2d<f32>;
@group(0) @binding(1) var smp        : sampler;
@group(0) @binding(2) var<uniform>   params    : CutoutParams;
@group(0) @binding(3) var selMask    : texture_2d<f32>;
@group(0) @binding(4) var<uniform>   maskFlags : MaskFlags;

@fragment
fn fs_cutout(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims = vec2i(textureDimensions(srcTex));
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let src = textureLoad(srcTex, coord, 0);

  // Mean-blur radius driven by edgeSimplicity (1-10).
  // The larger the simplicity, the bigger the blur kernel — small detail
  // washes away into uniform regions. Fidelity (1-3) divides that radius
  // to recover edge accuracy.
  let baseR = max(1, i32(params.edgeSimplicity));
  let fid = max(1, i32(params.edgeFidelity));
  let r = max(1, baseR / fid);

  var sumC = vec3f(0.0);
  var sumA = 0.0;
  var count = 0.0;
  for (var dy = -r; dy <= r; dy = dy + 1) {
    for (var dx = -r; dx <= r; dx = dx + 1) {
      let c = clamp(coord + vec2i(dx, dy), vec2i(0), dims - vec2i(1));
      let s = textureLoad(srcTex, c, 0);
      // Pre-multiplied accumulation so transparent pixels don't drag the
      // colour toward black.
      sumC = sumC + s.rgb * s.a;
      sumA = sumA + s.a;
      count = count + 1.0;
    }
  }
  let avgA = sumA / count;
  let avg = select(sumC / max(sumA, 0.0001), vec3f(0.0), sumA <= 0.0001);

  // Posterize each channel to N levels — the "cut paper" colour banding.
  let L = max(2.0, params.levels);
  let posterized = floor(avg * (L - 1.0) + 0.5) / (L - 1.0);

  let out = vec4f(posterized, avgA);

  if (maskFlags.hasMask != 0u) {
    let m = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    return mix(src, out, m);
  }
  return out;
}
