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
  hasMask       : u32,
  inputIsLinear : u32,
  _pad          : vec2u,
}

fn srgbEncodeF(c: f32) -> f32 {
  let x = max(c, 0.0);
  return select(1.055 * pow(x, 1.0 / 2.4) - 0.055, x * 12.92, x <= 0.0031308);
}
fn srgbDecodeF(c: f32) -> f32 {
  let x = max(c, 0.0);
  return select(pow((x + 0.055) / 1.055, 2.4), x / 12.92, x <= 0.04045);
}
fn srgbEncode(rgb: vec3f) -> vec3f { return vec3f(srgbEncodeF(rgb.r), srgbEncodeF(rgb.g), srgbEncodeF(rgb.b)); }
fn srgbDecode(rgb: vec3f) -> vec3f { return vec3f(srgbDecodeF(rgb.r), srgbDecodeF(rgb.g), srgbDecodeF(rgb.b)); }

// Brush Type IDs:
//   0 = Simple, 1 = Light Rough, 2 = Dark Rough, 3 = Wide Sharp,
//   4 = Wide Blurry, 5 = Sparkle
struct PaintDaubsParams {
  brushSize : f32,  // 1..50
  sharpness : f32,  // 0..40
  brushType : u32,
  _pad      : u32,
}

@group(0) @binding(0) var srcTex     : texture_2d<f32>;
@group(0) @binding(1) var smp        : sampler;
@group(0) @binding(2) var<uniform>   params    : PaintDaubsParams;
@group(0) @binding(3) var selMask    : texture_2d<f32>;
@group(0) @binding(4) var<uniform>   maskFlags : MaskFlags;

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }

/** Sample the 4-quadrant Kuwahara mean+variance for a given quadrant. The
 *  quadrant with the lowest luma variance wins — yields a paint-daub look
 *  where strokes follow local detail without softening edges. */
fn quadStats(coord: vec2i, q: vec2i, r: i32, dims: vec2i, inputIsLinear: bool) -> vec4<f32> {
  // Returns vec4 = (meanR, meanG, meanB, variance).
  var sumC = vec3f(0.0);
  var sumL = 0.0;
  var sumL2 = 0.0;
  var count = 0.0;
  for (var dy = 0; dy <= r; dy = dy + 1) {
    for (var dx = 0; dx <= r; dx = dx + 1) {
      let c = clamp(coord + vec2i(dx * q.x, dy * q.y), vec2i(0), dims - vec2i(1));
      let raw = textureLoad(srcTex, c, 0).rgb;
      let s = select(raw, srgbEncode(raw), inputIsLinear);
      sumC = sumC + s;
      let l = luma(s);
      sumL = sumL + l;
      sumL2 = sumL2 + l * l;
      count = count + 1.0;
    }
  }
  let mean = sumC / count;
  let mL = sumL / count;
  let variance = max(0.0, sumL2 / count - mL * mL);
  return vec4f(mean, variance);
}

@fragment
fn fs_paint_daubs(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims = vec2i(textureDimensions(srcTex));
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let src = textureLoad(srcTex, coord, 0);

  let inputIsLinear = maskFlags.inputIsLinear != 0u;
  let srcP = select(src.rgb, srgbEncode(src.rgb), inputIsLinear);

  // Map brushSize 1..50 to a kernel half-radius 1..12. Brush type slightly
  // modulates the kernel (Wide types use a bigger radius).
  var rBase = max(1, i32(round(params.brushSize * 0.25)));
  if (params.brushType == 3u || params.brushType == 4u) {
    rBase = rBase + 3;
  }
  let r = min(12, rBase);

  // Four-quadrant Kuwahara.
  let q0 = quadStats(coord, vec2i(-1, -1), r, dims, inputIsLinear);
  let q1 = quadStats(coord, vec2i( 1, -1), r, dims, inputIsLinear);
  let q2 = quadStats(coord, vec2i(-1,  1), r, dims, inputIsLinear);
  let q3 = quadStats(coord, vec2i( 1,  1), r, dims, inputIsLinear);

  // Pick the quadrant with the lowest variance. Sharpness biases the
  // variance comparison — higher sharpness pulls more aggressively
  // toward the most uniform quadrant.
  let sharp = 1.0 + params.sharpness * 0.05;
  let v0 = pow(q0.w + 0.0001, sharp);
  let v1 = pow(q1.w + 0.0001, sharp);
  let v2 = pow(q2.w + 0.0001, sharp);
  let v3 = pow(q3.w + 0.0001, sharp);

  var mean = q0.rgb;
  var bestVar = v0;
  if (v1 < bestVar) { mean = q1.rgb; bestVar = v1; }
  if (v2 < bestVar) { mean = q2.rgb; bestVar = v2; }
  if (v3 < bestVar) { mean = q3.rgb; bestVar = v3; }

  // Brush type tweaks the final colour:
  //   Light Rough → blend toward source (preserve detail)
  //   Dark Rough  → blend toward darker version
  //   Wide Blurry → average all four quadrants (softer)
  //   Sparkle     → blend with source highlights
  if (params.brushType == 1u) {
    mean = mix(mean, srcP, 0.25);
  } else if (params.brushType == 2u) {
    mean = mean * 0.85;
  } else if (params.brushType == 4u) {
    mean = (q0.rgb + q1.rgb + q2.rgb + q3.rgb) * 0.25;
  } else if (params.brushType == 5u) {
    let lSrc = luma(srcP);
    mean = mix(mean, srcP, smoothstep(0.6, 1.0, lSrc));
  }

  let outRgb = select(mean, srgbDecode(mean), inputIsLinear);
  let out = vec4f(outRgb, src.a);
  if (maskFlags.hasMask != 0u) {
    let m = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    return mix(src, out, m);
  }
  return out;
}
