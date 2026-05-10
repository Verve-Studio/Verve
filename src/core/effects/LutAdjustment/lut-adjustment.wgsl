// ─── LUT adjustment effect ───────────────────────────────────────────────────
//
// Applies a baked 3D LUT (with optional 1D shaper) to the layer. The cube
// is packed into a 2D atlas (width=N, height=N²; atlasY = b*N + g, atlasX
// = r). We sample two adjacent blue slabs with bilinear (R,G) and blend
// along blue manually for trilinear filtering.
//
// Colour-space handling: the source is either sRGB-encoded (rgba8 layers,
// after Stage 1-6 of the linear-light migration) or linear-light (rgba32f).
// The LUT declares its own input/output space; we convert the pixel into
// the LUT's input space, apply, then convert back to the layer's storage
// space. After that the result is mixed with the source by `intensity`.

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

// Space IDs:  0 = sRGB-encoded ([0,1] display)
//             1 = linear-light sRGB primaries ([0,∞))
struct LutParams {
  cubeSize     : f32,   // per-axis (e.g. 33)
  intensity    : f32,   // 0..1
  sourceSpace  : u32,   // 0 if rgba8 layer (sRGB), 1 if rgba32f (linear)
  lutInSpace   : u32,
  lutOutSpace  : u32,
  hasShaper    : u32,
  _pad0        : vec2f,
}

@group(0) @binding(0) var srcTex    : texture_2d<f32>;
@group(0) @binding(1) var smp       : sampler;
@group(0) @binding(2) var<uniform> params    : LutParams;
@group(0) @binding(3) var selMask   : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;
@group(0) @binding(5) var lutCube   : texture_2d<f32>;
@group(0) @binding(6) var lutShaper : texture_2d<f32>;
@group(0) @binding(7) var lutSampler : sampler;

// ── Colour-space helpers ────────────────────────────────────────────────────

fn srgbToLinearChan(c: f32) -> f32 {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}
fn linearToSrgbChan(c: f32) -> f32 {
  if (c <= 0.0) { return 0.0; }
  if (c <= 0.0031308) { return c * 12.92; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
fn srgbToLinear(c: vec3f) -> vec3f {
  return vec3f(srgbToLinearChan(c.r), srgbToLinearChan(c.g), srgbToLinearChan(c.b));
}
fn linearToSrgb(c: vec3f) -> vec3f {
  return vec3f(linearToSrgbChan(c.r), linearToSrgbChan(c.g), linearToSrgbChan(c.b));
}

/** Convert from `fromSpace` to `toSpace`. Both spaces are 0=sRGB-encoded
 *  or 1=linear-light. Anything else falls through unchanged (treated as
 *  already in the LUT's internal space — built-ins handle this internally). */
fn convertSpace(c: vec3f, fromSpace: u32, toSpace: u32) -> vec3f {
  if (fromSpace == toSpace) { return c; }
  if (fromSpace == 0u && toSpace == 1u) { return srgbToLinear(c); }
  if (fromSpace == 1u && toSpace == 0u) { return linearToSrgb(clamp(c, vec3f(0.0), vec3f(1.0))); }
  return c;
}

/** Sample the 1D shaper for one channel index (0=R, 1=G, 2=B). */
fn sampleShaper(t: f32, channel: u32) -> f32 {
  let row = (f32(channel) + 0.5) / 3.0;
  let s = textureSampleLevel(lutShaper, lutSampler, vec2f(clamp(t, 0.0, 1.0), row), 0.0);
  return s.r;
}

/** Trilinear sample of the cube atlas at (r, g, b)∈[0,1]³. */
fn sampleCube(rgb: vec3f) -> vec3f {
  let N = params.cubeSize;
  let c = clamp(rgb, vec3f(0.0), vec3f(1.0));
  // Index space [0, N-1] for each axis; offset by 0.5 for texel centres.
  let pf = c * (N - 1.0);
  let bi0 = floor(pf.b);
  let bi1 = min(bi0 + 1.0, N - 1.0);
  let bt  = pf.b - bi0;
  // Atlas: width=N, height=N*N, atlasY = bi*N + gi. We let the sampler do
  // bilinear (R,G) within a slab; blue is interpolated manually.
  let atlasW = N;
  let atlasH = N * N;
  // For a blue slab `bi`, the green axis spans atlasY = bi*N + 0 .. bi*N + (N-1).
  // We sample at (r/(N-1), (bi*N + gi)/H) using `pf.g` for `gi`, in pixel coords.
  let xs = (pf.r + 0.5) / atlasW;
  let ys0 = (bi0 * N + pf.g + 0.5) / atlasH;
  let ys1 = (bi1 * N + pf.g + 0.5) / atlasH;
  let s0 = textureSampleLevel(lutCube, lutSampler, vec2f(xs, ys0), 0.0).rgb;
  let s1 = textureSampleLevel(lutCube, lutSampler, vec2f(xs, ys1), 0.0).rgb;
  return mix(s0, s1, bt);
}

@fragment
fn fs_lut(in: AdjVertOut) -> @location(0) vec4f {
  // All `textureSample`s with implicit derivatives must happen in uniform
  // control flow — before any conditional branching that could cause an
  // early return. We therefore sample srcTex *and* the selection mask up
  // front (pure 1-px-per-fragment lookups; no mipmaps in play either way),
  // using `textureSampleLevel(..., 0.0)` so derivatives aren't required.
  let src = textureSampleLevel(srcTex, smp, in.uv, 0.0);
  let maskSample = textureSampleLevel(selMask, smp, in.uv, 0.0).r;

  if (src.a < 0.0001) { return src; }

  // Convert pixel into LUT input space.
  var c = src.rgb;
  c = convertSpace(c, params.sourceSpace, params.lutInSpace);

  // Optional 1D shaper.
  if (params.hasShaper == 1u) {
    c = vec3f(sampleShaper(c.r, 0u), sampleShaper(c.g, 1u), sampleShaper(c.b, 2u));
  }

  // 3D cube.
  var lutOut = sampleCube(c);

  // Convert back to source space.
  lutOut = convertSpace(lutOut, params.lutOutSpace, params.sourceSpace);

  // Selection mask (binary keep; weight by intensity within mask).
  var w = params.intensity;
  if (maskFlags.hasMask == 1u) {
    w = w * maskSample;
  }

  let outRgb = mix(src.rgb, lutOut, w);
  return vec4f(outRgb, src.a);
}
