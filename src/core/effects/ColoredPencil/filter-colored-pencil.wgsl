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

struct ColoredPencilParams {
  pencilWidth    : f32,  // 1..24 — pencil-mark thickness (px)
  strokePressure : f32,  // 0..15 — darker / heavier strokes
  paperBrightness: f32,  // 0..50 — paper base brightness
  opacity        : f32,  // 0..100 — overall filter strength
  _pad0          : f32,
  _pad1          : f32,
  _pad2          : f32,
  _pad3          : f32,
}

@group(0) @binding(0) var srcTex     : texture_2d<f32>;
@group(0) @binding(1) var smp        : sampler;
@group(0) @binding(2) var<uniform>   params    : ColoredPencilParams;
@group(0) @binding(3) var selMask    : texture_2d<f32>;
@group(0) @binding(4) var<uniform>   maskFlags : MaskFlags;

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn valueNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm2(p: vec2f) -> f32 {
  return valueNoise(p) * 0.65 + valueNoise(p * 2.17 + vec2f(5.2, 1.3)) * 0.35;
}

/** Anisotropic value-noise — long, broken streaks along `angle`. Used as
 *  the per-direction stroke MASK (where pencil marks exist). */
fn strokeMask(p: vec2f, angle: f32, width: f32) -> f32 {
  let c = cos(angle);
  let s = sin(angle);
  let r = vec2f(p.x * c + p.y * s, -p.x * s + p.y * c);
  let stretched = vec2f(r.x / (width * 9.0), r.y / max(0.5, width * 0.55));
  return fbm2(stretched);
}

/** Edge-aware directional blur: walk along `angle` for `length` pixels,
 *  averaging source colours with a bell-curve weight that's down-weighted
 *  by colour distance from the center pixel. This is the LIC step — the
 *  output is the source image SMEARED along that direction, so a stroke
 *  laid in this direction will read as one continuous pencil mark instead
 *  of a chopped sample of the per-pixel underlying colour.
 *
 *  Bilateral weighting (`expDist`) keeps the smear from bleeding across
 *  sharp colour boundaries — strokes near the edge of a dark object
 *  don't drag the object's colour out into lighter neighbours.
 */
fn streakColor(
  coord: vec2f,
  centerC: vec3f,
  angle: f32,
  length: f32,
  dims: vec2f,
) -> vec3f {
  let dir = vec2f(cos(angle), sin(angle));
  var sumC = vec3f(0.0);
  var sumW = 0.0;
  for (var i = -7; i <= 7; i = i + 1) {
    let t = f32(i) / 7.0;                       // -1..1
    let p = clamp(coord + dir * t * length, vec2f(0.0), dims - vec2f(1.0));
    let c = textureLoad(srcTex, vec2i(p), 0).rgb;
    let bell = 1.0 - abs(t);                    // peak at centre
    let dist = length3(c - centerC);            // colour distance
    let edge = exp(-dist * 4.0);                // bilateral weight
    let w = bell * edge;
    sumC = sumC + c * w;
    sumW = sumW + w;
  }
  return sumC / max(sumW, 0.0001);
}

fn length3(v: vec3f) -> f32 { return sqrt(dot(v, v)); }

@fragment
fn fs_colored_pencil(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord = vec2f(in.pos.xy);
  let dims = vec2f(textureDimensions(srcTex));
  let src = textureLoad(srcTex, vec2i(coord), 0);
  let l = luma(src.rgb);

  // Paper base.
  let paper = vec3f(0.85 + params.paperBrightness * 0.003);
  let paperGrain = (hash21(coord * 0.7) - 0.5) * 0.04;
  let paperFinal = clamp(paper + vec3f(paperGrain), vec3f(0.0), vec3f(1.0));

  let w = max(0.5, params.pencilWidth);
  let pressure = clamp(params.strokePressure * 0.0667, 0.0, 1.0);
  let darkness = 1.0 - l;

  // Three stroke directions, slightly de-tuned so they don't form a
  // perfect grid: primary +45°, cross −45°, scribbly near-vertical.
  let ang1 = 0.785;
  let ang2 = -0.785;
  let ang3 = 1.50;

  // Per-direction stroke MASKS (where the marks are).
  let n1 = strokeMask(coord, ang1, w);
  let n2 = strokeMask(coord, ang2, w * 1.15);
  let n3 = strokeMask(coord, ang3, w * 0.9);
  let m1 = smoothstep(0.42, 0.62, n1);
  let m2 = smoothstep(0.50, 0.70, n2);
  let m3 = smoothstep(0.55, 0.78, n3);

  // Per-direction STROKE COLOURS — the source image streaked along that
  // direction. This is what turns "overlay a pattern" into "transform
  // the layer into strokes". Stroke length scales with pencil width.
  let streakLen = w * 6.0;
  let c1 = streakColor(coord, src.rgb, ang1, streakLen, dims);
  let c2 = streakColor(coord, src.rgb, ang2, streakLen, dims);
  let c3 = streakColor(coord, src.rgb, ang3, streakLen, dims);

  // Darkness gates how many directions activate per pixel: highlights
  // get only sparse primary strokes; midtones get cross-hatching; the
  // darkest 40% of the image also gets the scribble layer.
  let primaryGate  = clamp(darkness * (0.35 + pressure * 1.8) + 0.08, 0.0, 1.0);
  let crossGate    = smoothstep(0.30, 0.75, darkness);
  let scribbleGate = smoothstep(0.55, 0.95, darkness);

  let a1 = clamp(m1 * primaryGate, 0.0, 1.0);
  let a2 = clamp(m2 * crossGate * (0.4 + pressure * 0.5), 0.0, 1.0);
  let a3 = clamp(m3 * scribbleGate * (0.3 + pressure * 0.4), 0.0, 1.0);

  // Composite the three direction-streaked colours by stroke presence,
  // then mix down toward paper between strokes. The pencil drags the
  // streaked colour slightly darker on heavier pressure.
  let totalA = a1 + a2 + a3;
  var strokeRGB = src.rgb;
  if (totalA > 0.001) {
    strokeRGB = (c1 * a1 + c2 * a2 + c3 * a3) / totalA;
  }
  strokeRGB = strokeRGB * (0.85 - pressure * 0.15);

  let mark = clamp(totalA, 0.0, 1.0);
  let pencilResult = mix(paperFinal, strokeRGB, mark);

  // Opacity slider blends the whole filter back toward the original.
  let opacity01 = clamp(params.opacity * 0.01, 0.0, 1.0);
  let out = mix(src.rgb, pencilResult, opacity01);
  let result = vec4f(out, src.a);

  if (maskFlags.hasMask != 0u) {
    let m = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    return mix(src, result, m);
  }
  return result;
}
