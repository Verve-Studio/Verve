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

struct LensBlurParams {
  kernelCount : u32,
  // Downsample factor used by fs_lens_down / fs_lens_up (1 = full res).
  factor      : u32,
  _pad1       : u32,
  _pad2       : u32,
}

struct KernelEntry {
  kx     : f32,
  ky     : f32,
  weight : f32,
  _pad   : f32,
}

@group(0) @binding(0) var srcTex                      : texture_2d<f32>;
@group(0) @binding(1) var smp                         : sampler;
@group(0) @binding(2) var<uniform> params             : LensBlurParams;
@group(0) @binding(3) var<storage, read> kernelEntries : array<KernelEntry>;

fn loadClamped(c: vec2i, dims: vec2u) -> vec4f {
  return textureLoad(srcTex, clamp(c, vec2i(0), vec2i(dims) - vec2i(1)), 0);
}

// Kernel offsets are whole pixels, so one load per tap is exact — the old
// 4-load bilinear fetch here did 4× the work for the same result.
@fragment
fn fs_lens_blur(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims  = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  var colorSum = vec4f(0.0);
  for (var i = 0u; i < params.kernelCount; i++) {
    let e = kernelEntries[i];
    colorSum += loadClamped(coord + vec2i(i32(e.kx), i32(e.ky)), dims) * e.weight;
  }
  return colorSum;
}

// Box-downsample by params.factor (large radii run at reduced resolution so
// the kernel stays small enough not to trip the OS GPU watchdog).
@fragment
fn fs_lens_down(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims = textureDimensions(srcTex);
  let f    = i32(params.factor);
  let base = vec2i(i32(in.pos.x), i32(in.pos.y)) * f;
  var sum  = vec4f(0.0);
  for (var y = 0; y < f; y++) {
    for (var x = 0; x < f; x++) {
      sum += loadClamped(base + vec2i(x, y), dims);
    }
  }
  return sum / f32(f * f);
}

// Bilinear upsample by params.factor back to full resolution.
@fragment
fn fs_lens_up(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims = textureDimensions(srcTex);
  let p    = in.pos.xy / f32(params.factor) - vec2f(0.5);
  let p0   = vec2i(floor(p));
  let t    = p - floor(p);
  let a = loadClamped(p0, dims);
  let b = loadClamped(p0 + vec2i(1, 0), dims);
  let d = loadClamped(p0 + vec2i(0, 1), dims);
  let e = loadClamped(p0 + vec2i(1, 1), dims);
  return mix(mix(a, b, t.x), mix(d, e, t.x), t.y);
}
