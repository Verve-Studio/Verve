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


// ── RGB → HSV conversion (H in 0..1) ────────────────────────────────────────
fn rgb2hsv(c: vec3f) -> vec3f {
  let maxC  = max(c.r, max(c.g, c.b));
  let minC  = min(c.r, min(c.g, c.b));
  let delta = maxC - minC;
  let v = maxC;
  var s = 0.0f;
  var h = 0.0f;
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

// ── Uniform struct (32 bytes) ─────────────────────────────────────────────────
struct CKParams {
  keyColor  : vec3f,   // sRGB 0..1 key color  (bytes  0–11)
  tolerance : f32,     // 0..100               (byte  12)
  softness  : f32,     // 0..100               (byte  16)
  dilation  : f32,     // 0..20 px             (byte  20)
  // tail-padded to 32 bytes
}

@group(0) @binding(0) var srcTex    : texture_2d<f32>;
@group(0) @binding(1) var smp       : sampler;
@group(0) @binding(2) var<uniform> params    : CKParams;
@group(0) @binding(3) var selMask   : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

// ── Helper: compute keyed alpha for a single pixel ────────────────────────────
fn keyedAlpha(src: vec4f, kHsv: vec3f, tol: f32, soft: f32) -> f32 {
  if (src.a < 0.0001) { return 0.0; }
  let pHsv   = rgb2hsv(src.rgb);
  let dH_raw = abs(pHsv.x - kHsv.x);
  let dH     = min(dH_raw, 1.0 - dH_raw) * 2.0;
  let dS     = abs(pHsv.y - kHsv.y);
  let dV     = abs(pHsv.z - kHsv.z);
  let satW   = min(pHsv.y, kHsv.y);
  let dist   = ((dH * satW) + dS + dV) / 3.0 * 100.0;
  if (dist <= tol) { return 0.0; }
  if (soft > 0.0001 && dist < tol + soft) { return src.a * (dist - tol) / soft; }
  return src.a;
}

@fragment
fn fs_color_key(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);

  // Already transparent — nothing to key; preserve as-is.
  if (src.a < 0.0001) { return src; }

  let dims = textureDimensions(srcTex);
  let coord = vec2i(in.pos.xy);
  let kHsv = rgb2hsv(params.keyColor);
  let tol  = params.tolerance;
  let soft = params.softness;

  // Compute alpha for this pixel
  var alpha = keyedAlpha(src, kHsv, tol, soft);

  // Dilation: expand the keyed-out region by sampling the neighborhood.
  let dilRad = i32(params.dilation);
  if (dilRad > 0 && alpha > 0.0) {
    let kw   = 2 * dilRad + 1;
    let kTot = kw * kw;
    for (var ki = 0; ki < kTot; ki++) {
      let dy = ki / kw - dilRad;
      let dx = ki % kw - dilRad;
      let nc = clamp(coord + vec2i(dx, dy), vec2i(0), vec2i(i32(dims.x) - 1, i32(dims.y) - 1));
      let nsrc = textureLoad(srcTex, nc, 0);
      let nAlpha = keyedAlpha(nsrc, kHsv, tol, soft);
      if (nAlpha < alpha) { alpha = nAlpha; }
    }
  }

  let adjusted = vec4f(src.rgb, alpha);
  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return mix(src, adjusted, mask);
}
