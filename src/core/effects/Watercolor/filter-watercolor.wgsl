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

struct WatercolorParams {
  brushDetail    : f32,  // 1..14  — higher = preserve more fine detail
  shadowIntensity: f32,  // 0..10  — pigment-pool darkening at edges
  texture        : f32,  // 1..3   — paper-grain strength
  _pad           : f32,
}

@group(0) @binding(0) var srcTex     : texture_2d<f32>;
@group(0) @binding(1) var smp        : sampler;
@group(0) @binding(2) var<uniform>   params    : WatercolorParams;
@group(0) @binding(3) var selMask    : texture_2d<f32>;
@group(0) @binding(4) var<uniform>   maskFlags : MaskFlags;

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }

fn clampPx(p: vec2i, dims: vec2i) -> vec2i {
  return clamp(p, vec2i(0), dims - vec2i(1));
}

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

/** Sobel luminance gradient — drives the edge-pool darkening. */
fn sobelMag(pi: vec2i, dims: vec2i, inputIsLinear: bool) -> f32 {
  let tlS = textureLoad(srcTex, clampPx(pi + vec2i(-1, -1), dims), 0).rgb;
  let tcS = textureLoad(srcTex, clampPx(pi + vec2i(0, -1), dims), 0).rgb;
  let trS = textureLoad(srcTex, clampPx(pi + vec2i(1, -1), dims), 0).rgb;
  let mlS = textureLoad(srcTex, clampPx(pi + vec2i(-1, 0), dims), 0).rgb;
  let mrS = textureLoad(srcTex, clampPx(pi + vec2i(1, 0), dims), 0).rgb;
  let blS = textureLoad(srcTex, clampPx(pi + vec2i(-1, 1), dims), 0).rgb;
  let bcS = textureLoad(srcTex, clampPx(pi + vec2i(0, 1), dims), 0).rgb;
  let brS = textureLoad(srcTex, clampPx(pi + vec2i(1, 1), dims), 0).rgb;
  let tl = luma(select(tlS, srgbEncode(tlS), inputIsLinear));
  let tc = luma(select(tcS, srgbEncode(tcS), inputIsLinear));
  let tr = luma(select(trS, srgbEncode(trS), inputIsLinear));
  let ml = luma(select(mlS, srgbEncode(mlS), inputIsLinear));
  let mr = luma(select(mrS, srgbEncode(mrS), inputIsLinear));
  let bl = luma(select(blS, srgbEncode(blS), inputIsLinear));
  let bc = luma(select(bcS, srgbEncode(bcS), inputIsLinear));
  let br = luma(select(brS, srgbEncode(brS), inputIsLinear));
  let gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  let gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
  return sqrt(gx * gx + gy * gy);
}

@fragment
fn fs_watercolor(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord = vec2f(in.pos.xy);
  let coordI = vec2i(coord);
  let dims = vec2i(textureDimensions(srcTex));
  let src = textureLoad(srcTex, coordI, 0);

  let inputIsLinear = maskFlags.inputIsLinear != 0u;
  let srcP = select(src.rgb, srgbEncode(src.rgb), inputIsLinear);

  // ── 1. Wash (edge-preserving smoothing) ─────────────────────────────────
  // Watercolor blends colours into soft pools within an outline. Approximate
  // with a small bilateral kernel: every sample's weight is multiplied by
  // its colour similarity to the centre, so flat regions get smoothed
  // heavily but edges are preserved (they become darker via step 3).
  //
  // brushDetail (1..14) inversely drives the kernel radius: low detail = a
  // big wash; high detail = a narrow smoothing window that keeps fine
  // features.
  let r = max(1, i32(round(8.0 - params.brushDetail * 0.5)));
  let centerC = srcP;
  var sumC = vec3f(0.0);
  var sumW = 0.0;
  for (var dy = -r; dy <= r; dy = dy + 1) {
    for (var dx = -r; dx <= r; dx = dx + 1) {
      let p = clampPx(coordI + vec2i(dx, dy), dims);
      let cRaw = textureLoad(srcTex, p, 0).rgb;
      let c = select(cRaw, srgbEncode(cRaw), inputIsLinear);
      let cd = length(c - centerC);
      // Spatial gaussian × colour gaussian — classic bilateral filter.
      let radial = exp(-(f32(dx * dx + dy * dy)) / f32(2 * r * r));
      let edge = exp(-cd * cd * 12.0);
      let w = radial * edge;
      sumC = sumC + c * w;
      sumW = sumW + w;
    }
  }
  let washed = sumC / max(sumW, 0.0001);

  // ── 2. Mild colour quantisation ─────────────────────────────────────────
  // Watercolor pigment doesn't reproduce every micro-shade — it banishes
  // subtle variation. Snap each channel to ~24 levels for a gentle
  // poster-band effect that reads as "wet pigment pooling into bands".
  let L = 24.0;
  let banded = floor(washed * (L - 1.0) + 0.5) / (L - 1.0);

  // ── 3. Edge pooling (shadow intensity) ──────────────────────────────────
  // Real watercolor darkens at edges as pigment settles where the wash
  // dries. shadowIntensity (0..10) is multiplied by the Sobel magnitude
  // to produce a per-pixel darkening factor.
  let edgeMag = sobelMag(coordI, dims, inputIsLinear);
  let shadow = clamp(edgeMag * params.shadowIntensity * 0.25, 0.0, 0.7);
  let withShadows = banded * (1.0 - shadow);

  // ── 4. Slight desaturation ──────────────────────────────────────────────
  // Watercolor pigments diluted on paper are intrinsically less saturated
  // than the photographic source. Pull 12% toward luma — barely
  // perceptible but it tips the look toward "painted".
  let lum = luma(withShadows);
  let washy = mix(vec3f(lum), withShadows, 0.88);

  // ── 5. Paper grain ──────────────────────────────────────────────────────
  // texture (1..3) drives a hash-noise grain that lives ON the paper, NOT
  // a pattern overlaid on the image. Multiplicative so darker areas don't
  // bleach out from added noise.
  let grain = (hash21(coord * 0.7) - 0.5) * 0.06 * params.texture;
  let result = clamp(washy * (1.0 + grain), vec3f(0.0), vec3f(2.0));

  let outRgb = select(result, srgbDecode(result), inputIsLinear);
  let outRGB = vec4f(outRgb, src.a);
  if (maskFlags.hasMask != 0u) {
    let m = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    return mix(src, outRGB, m);
  }
  return outRGB;
}
