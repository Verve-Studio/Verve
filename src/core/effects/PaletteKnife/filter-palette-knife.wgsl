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

struct PaletteKnifeParams {
  strokeSize  : f32,  // 1..50
  strokeDetail: f32,  // 1..3
  softness    : f32,  // 0..10
  _pad        : f32,
}

@group(0) @binding(0) var srcTex     : texture_2d<f32>;
@group(0) @binding(1) var smp        : sampler;
@group(0) @binding(2) var<uniform>   params    : PaletteKnifeParams;
@group(0) @binding(3) var selMask    : texture_2d<f32>;
@group(0) @binding(4) var<uniform>   maskFlags : MaskFlags;

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }

@fragment
fn fs_palette_knife(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims = vec2i(textureDimensions(srcTex));
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let src = textureLoad(srcTex, coord, 0);

  // strokeSize 1..50 → kernel half-radius 1..15.
  let r = min(15, max(1, i32(round(params.strokeSize * 0.3))));

  // Two-pass approach: a wide mean (smooth patches) blended with an
  // edge-aware boundary (knife edges where adjacent patches abut).
  var sumC = vec3f(0.0);
  var sumA = 0.0;
  var sumL = 0.0;
  var sumL2 = 0.0;
  var count = 0.0;
  for (var dy = -r; dy <= r; dy = dy + 1) {
    for (var dx = -r; dx <= r; dx = dx + 1) {
      let c = clamp(coord + vec2i(dx, dy), vec2i(0), dims - vec2i(1));
      let s = textureLoad(srcTex, c, 0);
      sumC = sumC + s.rgb * s.a;
      sumA = sumA + s.a;
      let l = luma(s.rgb);
      sumL = sumL + l;
      sumL2 = sumL2 + l * l;
      count = count + 1.0;
    }
  }
  let avgA = sumA / count;
  let avg = select(sumC / max(sumA, 0.0001), vec3f(0.0), sumA <= 0.0001);
  let mL = sumL / count;
  let variance = max(0.0, sumL2 / count - mL * mL);
  // Edge intensity: high where the kernel straddles a colour boundary.
  let edge = clamp(variance * (params.strokeDetail * 4.0), 0.0, 1.0);

  // Pull more strongly toward the source where an edge is detected
  // (preserves knife strokes); blur out flat regions for the palette feel.
  var out = mix(avg, src.rgb, edge);

  // Softness 0..10: linear lerp back toward avg.
  let soft = params.softness * 0.1;
  out = mix(out, avg, soft);

  let result = vec4f(out, avgA);
  if (maskFlags.hasMask != 0u) {
    let m = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    return mix(src, result, m);
  }
  return result;
}
