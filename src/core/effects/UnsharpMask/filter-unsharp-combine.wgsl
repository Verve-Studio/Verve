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

struct UnsharpParams {
  amount    : u32,
  threshold : u32,
  _pad0     : u32,
  _pad1     : u32,
}

@group(0) @binding(0) var origTex             : texture_2d<f32>;
@group(0) @binding(1) var smp                 : sampler;
@group(0) @binding(2) var blurredTex          : texture_2d<f32>;
@group(0) @binding(3) var<uniform> params     : UnsharpParams;

@fragment
fn fs_unsharp_combine(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord   = vec2i(i32(in.pos.x), i32(in.pos.y));
  let orig    = textureLoad(origTex,    coord, 0);
  let blurred = textureLoad(blurredTex, coord, 0);

  let scale = f32(params.amount) / 100.0;
  let thr   = f32(params.threshold) / 255.0;

  let dR = orig.r - blurred.r;
  let dG = orig.g - blurred.g;
  let dB = orig.b - blurred.b;

  let lumaDiff = abs(0.299 * dR + 0.587 * dG + 0.114 * dB);

  if (lumaDiff > thr) {
    return vec4f(
      clamp(orig.r + scale * dR, 0.0, 1.0),
      clamp(orig.g + scale * dG, 0.0, 1.0),
      clamp(orig.b + scale * dB, 0.0, 1.0),
      orig.a,
    );
  }
  return vec4f(orig.rgb, orig.a);
}
