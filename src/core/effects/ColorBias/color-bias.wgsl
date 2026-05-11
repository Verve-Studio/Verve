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

// ── Uniform struct (48 bytes) ─────────────────────────────────────────────────
struct CBParams {
  targetCol : vec3f, // sample colour, 0..1 sRGB       (bytes  0–11)
  range   : f32,     // 0..100 max colour distance     (byte  12)
  falloff : f32,     // 0..100 % of range that fades   (byte  16)
  metric  : u32,     // 0=RGB, 1=HSV, 2=LAB            (byte  20)
  // 8-byte pad so outputCol lands on a 16-byte boundary
  outputCol   : vec3f, // snap destination, 0..1 sRGB  (bytes 32–43)
  inputLinear : u32,   // 1 = source texture is linear-light
                       // (rgba32float layers); 0 = source is sRGB
                       // encoded (rgba8). Determines whether we
                       // gamma-encode at entry / decode at output.
                                                       // (bytes 44–47)
}

@group(0) @binding(0) var srcTex    : texture_2d<f32>;
@group(0) @binding(1) var smp       : sampler;
@group(0) @binding(2) var<uniform> params    : CBParams;
@group(0) @binding(3) var selMask   : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

// ── Colour-space helpers ─────────────────────────────────────────────────────

// sRGB 0..1 → HSV (H in 0..1, S/V in 0..1).
fn rgb2hsv(c: vec3f) -> vec3f {
  let maxC  = max(c.r, max(c.g, c.b));
  let minC  = min(c.r, min(c.g, c.b));
  let delta = maxC - minC;
  let v = maxC;
  var s = 0.0;
  var h = 0.0;
  if (delta > 0.00001) {
    s = delta / maxC;
    if (maxC == c.r) {
      h = (c.g - c.b) / delta;
      h = h - floor(h / 6.0) * 6.0;
      h = h / 6.0;
    } else if (maxC == c.g) {
      h = ((c.b - c.r) / delta + 2.0) / 6.0;
    } else {
      h = ((c.r - c.g) / delta + 4.0) / 6.0;
    }
  }
  return vec3f(h, s, v);
}

// sRGB 0..1 → linear-light RGB (gamma decode).
fn srgbToLinear(c: vec3f) -> vec3f {
  let lo = c / 12.92;
  let hi = pow(max((c + 0.055) / 1.055, vec3f(0.0)), vec3f(2.4));
  return select(hi, lo, c <= vec3f(0.04045));
}

// Linear-light RGB → sRGB 0..1 (gamma encode). HDR values >1 produce
// extended-sRGB results — fine because they're well outside any reasonable
// `range` for a target colour and won't get snapped.
fn linearToSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

// Linear-RGB (D65) → CIE XYZ.
fn linearToXYZ(c: vec3f) -> vec3f {
  return vec3f(
    c.r * 0.4124564 + c.g * 0.3575761 + c.b * 0.1804375,
    c.r * 0.2126729 + c.g * 0.7151522 + c.b * 0.0721750,
    c.r * 0.0193339 + c.g * 0.1191920 + c.b * 0.9503041,
  );
}

// CIE XYZ → CIE L*a*b* (D65 reference white, perceptually uniform).
fn xyzToLab(xyz: vec3f) -> vec3f {
  let white = vec3f(0.95047, 1.00000, 1.08883); // D65 reference white
  let t = xyz / white;
  // f(t) = t^(1/3) when t > (6/29)^3, else linear approximation.
  let cube = pow(max(t, vec3f(0.0)), vec3f(1.0 / 3.0));
  let linApprox = 7.787 * t + 16.0 / 116.0;
  let f = select(linApprox, cube, t > vec3f(0.008856));
  return vec3f(
    116.0 * f.y - 16.0,
    500.0 * (f.x - f.y),
    200.0 * (f.y - f.z),
  );
}

fn rgbToLab(c: vec3f) -> vec3f {
  return xyzToLab(linearToXYZ(srgbToLinear(c)));
}

// ── Distance metrics — all return a 0..100-ish scalar ──────────────────────

// Euclidean RGB. Max distance in [0,1]³ is sqrt(3); divide by it then scale.
fn rgbDistance(a: vec3f, b: vec3f) -> f32 {
  return length(a - b) / 1.7320508 * 100.0;
}

// HSV: hue diff (wrapping), weighted by min(saturation) so low-sat colours
// don't suffer from unstable hue. Saturation and value contribute linearly.
fn hsvDistance(a: vec3f, b: vec3f) -> f32 {
  let aHsv = rgb2hsv(a);
  let bHsv = rgb2hsv(b);
  let dHraw = abs(aHsv.x - bHsv.x);
  let dH    = min(dHraw, 1.0 - dHraw) * 2.0;   // 0..1
  let dS    = abs(aHsv.y - bHsv.y);            // 0..1
  let dV    = abs(aHsv.z - bHsv.z);            // 0..1
  let satW  = min(aHsv.y, bHsv.y);             // de-weight unreliable hues
  return ((dH * satW) + dS + dV) / 3.0 * 100.0;
}

// CIE76 ΔE. Perceptually uniform (1 unit ≈ "just noticeable difference").
// Max ΔE inside the sRGB gamut ≈ 100 — slider already matches that scale.
fn labDistance(a: vec3f, b: vec3f) -> f32 {
  return length(rgbToLab(a) - rgbToLab(b));
}

fn colourDistance(a: vec3f, b: vec3f, metric: u32) -> f32 {
  if (metric == 1u) { return hsvDistance(a, b); }
  if (metric == 2u) { return labDistance(a, b); }
  return rgbDistance(a, b);
}

// Hash-noise dither — pseudo-random ±0.5 LSB noise per fragment to break
// 8-bit quantisation bands in the falloff transition. Same pixel ↔ same
// noise, so the dither is stable frame-to-frame (no shimmer).
fn ditherNoise(pos: vec2f) -> f32 {
  return fract(sin(dot(pos, vec2f(12.9898, 78.233))) * 43758.5453) - 0.5;
}

@fragment
fn fs_color_bias(in: AdjVertOut) -> @location(0) vec4f {
  let raw = textureSample(srcTex, smp, in.uv);
  if (raw.a < 0.0001) { return raw; }

  // Operate in sRGB display space so the metric matches what the eye
  // (and the eyedropper) sees. Linear-light source layers (rgba32float)
  // are gamma-encoded on entry; the snap result is gamma-decoded back
  // to linear before storage.
  let srcSrgb = select(raw.rgb, linearToSrgb(raw.rgb), params.inputLinear == 1u);

  let d = colourDistance(srcSrgb, params.targetCol, params.metric);

  // Inner radius — pixels closer than this snap fully to target.
  // Outer radius (range) — pixels beyond this are untouched.
  // Between inner and outer: linear fade from 1.0 (full snap) down to 0.0
  // so the boundary lerps back into the original pixel — no hard edge.
  let inner = params.range * (1.0 - params.falloff * 0.01);
  var t = 0.0;
  if (d <= inner) {
    t = 1.0;
  } else if (d < params.range) {
    t = (params.range - d) / max(params.range - inner, 0.0001);
  }

  var outSrgb = mix(srcSrgb, params.outputCol, t);

  // Dither the falloff zone for 8-bit output to break 1/255 quantisation
  // bands. Skipped when output is rgba32float (no quantisation) and when
  // the pixel is fully snapped or untouched (no gradient to band).
  if (params.inputLinear == 0u && t > 0.0 && t < 1.0) {
    let n = ditherNoise(in.pos.xy) / 255.0;
    outSrgb = outSrgb + vec3f(n, n, n);
  }

  let outRgb = select(outSrgb, srgbToLinear(outSrgb), params.inputLinear == 1u);
  let adjusted = vec4f(outRgb, raw.a);

  var mask = 1.0;
  if (maskFlags.hasMask != 0u) {
    mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
  }
  return mix(raw, adjusted, mask);
}
