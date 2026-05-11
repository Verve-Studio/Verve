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

struct MaskFlags { hasMask : u32, _pad : vec3u, }

struct DryBrushParams {
  brushSize  : f32,  // 0-10
  brushDetail: f32,  // 0-10
  texture    : f32,  // 1-3
  _pad       : f32,
}

@group(0) @binding(0) var srcTex     : texture_2d<f32>;
@group(0) @binding(1) var smp        : sampler;
@group(0) @binding(2) var<uniform>   params    : DryBrushParams;
@group(0) @binding(3) var selMask    : texture_2d<f32>;
@group(0) @binding(4) var<uniform>   maskFlags : MaskFlags;

fn rand(co: vec2f) -> f32 {
  return fract(sin(dot(co, vec2f(12.9898, 78.233))) * 43758.5453);
}

@fragment
fn fs_dry_brush(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims = vec2i(textureDimensions(srcTex));
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let src = textureLoad(srcTex, coord, 0);

  // Brush size → blur radius. brushSize 0..10 maps to 0..8 pixels.
  let r = i32(round(params.brushSize * 0.8));

  var sumC = vec3f(0.0);
  var sumA = 0.0;
  var count = 0.0;
  for (var dy = -r; dy <= r; dy = dy + 1) {
    for (var dx = -r; dx <= r; dx = dx + 1) {
      let c = clamp(coord + vec2i(dx, dy), vec2i(0), dims - vec2i(1));
      let s = textureLoad(srcTex, c, 0);
      sumC = sumC + s.rgb * s.a;
      sumA = sumA + s.a;
      count = count + 1.0;
    }
  }
  let avgA = sumA / count;
  let avg = select(sumC / max(sumA, 0.0001), vec3f(0.0), sumA <= 0.0001);

  // Detail = number of preserved colour levels. brushDetail 0 → 3 levels
  // (heavy posterise); 10 → 32 levels (gentle reduction).
  let levels = 3.0 + params.brushDetail * 2.9;
  let posterized = floor(avg * (levels - 1.0) + 0.5) / (levels - 1.0);

  // Texture: subtle additive grain that "breaks" smooth regions and
  // makes the brushwork feel dry. Texture 1..3 → low..high grain.
  let grain = (rand(vec2f(in.pos.xy) * 0.13) - 0.5) * 0.06 * params.texture;
  let out = vec4f(posterized + vec3f(grain), avgA);

  if (maskFlags.hasMask != 0u) {
    let m = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    return mix(src, out, m);
  }
  return out;
}
