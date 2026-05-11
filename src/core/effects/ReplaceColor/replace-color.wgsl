// Replace Color — LAB/LCH-based chromaticity swap that preserves shading.
//
// For each pixel:
//   1. Decode to CIE L*a*b*; convert to LCH (cylindrical).
//   2. Compute hue distance to the user's "original" colour. Pixels outside
//      the `hueRange` window are untouched. A 30 %-wide smooth falloff at
//      the edge of the window keeps the selection from ringing.
//   3. Very low-chroma pixels (~grays) get a confidence weight that fades
//      them out — their hue is dominated by quantisation noise so blindly
//      "matching" them produces speckle.
//   4. For pixels in the window: rotate the pixel's hue by the original→
//      target hue delta and scale its chroma by `target_C / orig_C`. This
//      preserves shading because L is left unchanged and chroma is scaled
//      proportionally — a shadow stays a less-saturated version of the new
//      colour, not a flat target swatch.
//   5. `amount` linearly attenuates the shift so the user can dial it in.
//   6. The host's selection mask (when present) further attenuates the
//      result — exactly the same pattern as every other adjustment.
//
// Linear-light input layers (rgba32float) are gamma-encoded on entry and
// gamma-decoded on exit so the LAB conversion uses display-relative sRGB,
// matching how the user picked the original / target colour from the
// canvas.

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

struct ReplaceColorParams {
  origCol     : vec3f,
  hueRange    : f32,   // degrees, 0..180
  targetCol   : vec3f,
  amount      : f32,   // 0..100
  inputLinear : u32,   // 1 when source layer is rgba32float (scene-linear)
  _pad1       : u32,
  _pad2       : u32,
  _pad3       : u32,
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var smp      : sampler;
@group(0) @binding(2) var<uniform> params    : ReplaceColorParams;
@group(0) @binding(3) var selMask  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

// ── sRGB ↔ linear ↔ XYZ ↔ LAB ──────────────────────────────────────────────

fn srgbToLinear(c: vec3f) -> vec3f {
  let lo = c / 12.92;
  let hi = pow(max((c + 0.055) / 1.055, vec3f(0.0)), vec3f(2.4));
  return select(hi, lo, c <= vec3f(0.04045));
}

fn linearToSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn linearToXYZ(c: vec3f) -> vec3f {
  return vec3f(
    c.r * 0.4124564 + c.g * 0.3575761 + c.b * 0.1804375,
    c.r * 0.2126729 + c.g * 0.7151522 + c.b * 0.0721750,
    c.r * 0.0193339 + c.g * 0.1191920 + c.b * 0.9503041,
  );
}

fn xyzToLinear(xyz: vec3f) -> vec3f {
  return vec3f(
    xyz.x *  3.2404542 + xyz.y * -1.5371385 + xyz.z * -0.4985314,
    xyz.x * -0.9692660 + xyz.y *  1.8760108 + xyz.z *  0.0415560,
    xyz.x *  0.0556434 + xyz.y * -0.2040259 + xyz.z *  1.0572252,
  );
}

fn xyzToLab(xyz: vec3f) -> vec3f {
  let white = vec3f(0.95047, 1.00000, 1.08883); // D65
  let t = xyz / white;
  let cube = pow(max(t, vec3f(0.0)), vec3f(1.0 / 3.0));
  let linApprox = 7.787 * t + 16.0 / 116.0;
  let f = select(linApprox, cube, t > vec3f(0.008856));
  return vec3f(
    116.0 * f.y - 16.0,
    500.0 * (f.x - f.y),
    200.0 * (f.y - f.z),
  );
}

fn labToXYZ(lab: vec3f) -> vec3f {
  let white = vec3f(0.95047, 1.00000, 1.08883);
  let fy = (lab.x + 16.0) / 116.0;
  let fx = lab.y / 500.0 + fy;
  let fz = fy - lab.z / 200.0;
  let f = vec3f(fx, fy, fz);
  let cube = f * f * f;
  // Inverse of f(t) = 7.787 t + 16/116 on the linear branch.
  let linApprox = (f - 16.0 / 116.0) / 7.787;
  let t = select(linApprox, cube, cube > vec3f(0.008856));
  return t * white;
}

fn rgbToLab(c: vec3f) -> vec3f {
  return xyzToLab(linearToXYZ(srgbToLinear(c)));
}

fn labToRgb(lab: vec3f) -> vec3f {
  return linearToSrgb(xyzToLinear(labToXYZ(lab)));
}

// ── LAB ↔ LCH ──────────────────────────────────────────────────────────────
// LCH is just polar LAB: L unchanged, C = √(a²+b²), H = atan2(b, a). Hue
// distance is the only sensible "how similar in hue?" metric, so the
// selection window runs in this space.

fn labToLch(lab: vec3f) -> vec3f {
  let C = sqrt(lab.y * lab.y + lab.z * lab.z);
  let H = atan2(lab.z, lab.y);
  return vec3f(lab.x, C, H);
}

fn lchToLab(lch: vec3f) -> vec3f {
  return vec3f(lch.x, lch.y * cos(lch.z), lch.y * sin(lch.z));
}

// Shortest signed angular delta `to - from`, wrapped to (-π, π].
fn shortestAngle(from_: f32, to_: f32) -> f32 {
  let pi    = 3.141592653589793;
  let twoPi = 6.283185307179586;
  let d = to_ - from_;
  return d - twoPi * floor((d + pi) / twoPi);
}

@fragment
fn fs_replace_color(in: AdjVertOut) -> @location(0) vec4f {
  let raw = textureSample(srcTex, smp, in.uv);
  if (raw.a < 0.0001) { return raw; }

  // Operate in sRGB display space so the original/target colours the user
  // picked from the canvas line up with what the math sees.
  let srcSrgb = select(raw.rgb, linearToSrgb(raw.rgb), params.inputLinear == 1u);

  let pixelLab   = rgbToLab(srcSrgb);
  let origLab    = rgbToLab(params.origCol);
  let targetLab  = rgbToLab(params.targetCol);

  let pixelLch   = labToLch(pixelLab);
  let origLch    = labToLch(origLab);
  let targetLch  = labToLch(targetLab);

  // ── Selection window ─────────────────────────────────────────────────
  // Hue distance in degrees. The range is the half-width of the window so
  // a value of 30 means "match anything within ±30° of the original hue".
  let pi    = 3.141592653589793;
  let twoPi = 6.283185307179586;
  let hueDiffRad = shortestAngle(origLch.z, pixelLch.z);
  let hueDiffDeg = abs(hueDiffRad) * 180.0 / pi;

  var hueMask = 0.0;
  let range = max(params.hueRange, 0.001);
  if (hueDiffDeg < range) {
    // Flat 1.0 across the inner 70 % of the window; smooth fade to 0 in
    // the outer 30 %. Keeps the selection crisp on the bulk of the
    // colour range while still avoiding a hard edge artifact.
    let t = hueDiffDeg / range;       // 0 at hue match, 1 at window edge
    hueMask = 1.0 - smoothstep(0.7, 1.0, t);
  }

  // Confidence weight: hue is unstable when chroma is tiny (pixel is
  // nearly gray — small a/b noise dominates the angle). Fade those out
  // so a 50 %-gray background isn't accidentally swept up.
  let chromaConfidence = smoothstep(1.0, 4.0, pixelLch.y);
  let mask = hueMask * chromaConfidence;

  // ── Chromaticity shift ───────────────────────────────────────────────
  // Rotate the pixel's hue toward the target's hue and scale its chroma
  // proportionally. Lightness (L) stays — that's the entire "preserve
  // shading" guarantee. A shadow with low L and low C stays at the same
  // L but its hue (and proportionate C) shift toward the target.
  let hueShift    = shortestAngle(origLch.z, targetLch.z);
  let chromaRatio = targetLch.y / max(origLch.y, 1.0);
  let strength    = mask * (params.amount * 0.01);

  let newH = pixelLch.z + hueShift * strength;
  // mix(1, chromaRatio, strength) — at strength=0 chroma is unchanged,
  // at strength=1 it scales by chromaRatio.
  let newC = pixelLch.y * mix(1.0, chromaRatio, strength);
  let newL = pixelLch.x;

  // Wrap H back into (-π, π] just so downstream cos/sin stay in their
  // sweet spot; mathematically unnecessary but tidier under inspection.
  var wrappedH = newH - twoPi * floor((newH + pi) / twoPi);

  let newLab  = lchToLab(vec3f(newL, newC, wrappedH));
  let outSrgb = labToRgb(newLab);

  let outRgb   = select(outSrgb, srgbToLinear(outSrgb), params.inputLinear == 1u);
  let adjusted = vec4f(outRgb, raw.a);

  var selW = 1.0;
  if (maskFlags.hasMask != 0u) {
    selW = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
  }
  return mix(raw, adjusted, selW);
}
