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

struct PosterEdgesParams {
  edgeThickness: f32,  // 0..10
  edgeIntensity: f32,  // 0..10
  posterization: f32,  // 0..6
  _pad         : f32,
}

@group(0) @binding(0) var srcTex     : texture_2d<f32>;
@group(0) @binding(1) var smp        : sampler;
@group(0) @binding(2) var<uniform>   params    : PosterEdgesParams;
@group(0) @binding(3) var selMask    : texture_2d<f32>;
@group(0) @binding(4) var<uniform>   maskFlags : MaskFlags;

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }

fn clampPx(p: vec2i, dims: vec2i) -> vec2i {
  return clamp(p, vec2i(0), dims - vec2i(1));
}

@fragment
fn fs_poster_edges(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims = vec2i(textureDimensions(srcTex));
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let src = textureLoad(srcTex, coord, 0);

  // Posterise each channel. posterization 0..6 → 2..8 levels per channel.
  let L = 2.0 + params.posterization;
  let posterized = floor(src.rgb * (L - 1.0) + 0.5) / (L - 1.0);

  // Sobel edge magnitude. edgeThickness 0..10 widens the gradient samples,
  // which both broadens detected edges and increases the threshold.
  let step = max(1, i32(round(params.edgeThickness * 0.4)));
  let tl = luma(textureLoad(srcTex, clampPx(coord + vec2i(-step, -step), dims), 0).rgb);
  let tc = luma(textureLoad(srcTex, clampPx(coord + vec2i(0, -step), dims), 0).rgb);
  let tr = luma(textureLoad(srcTex, clampPx(coord + vec2i( step, -step), dims), 0).rgb);
  let ml = luma(textureLoad(srcTex, clampPx(coord + vec2i(-step, 0), dims), 0).rgb);
  let mr = luma(textureLoad(srcTex, clampPx(coord + vec2i( step, 0), dims), 0).rgb);
  let bl = luma(textureLoad(srcTex, clampPx(coord + vec2i(-step,  step), dims), 0).rgb);
  let bc = luma(textureLoad(srcTex, clampPx(coord + vec2i(0,  step), dims), 0).rgb);
  let br = luma(textureLoad(srcTex, clampPx(coord + vec2i( step,  step), dims), 0).rgb);

  let gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  let gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  let mag = sqrt(gx * gx + gy * gy);

  // edgeIntensity 0..10 → multiplier 0..3 on the edge magnitude.
  let intensity = clamp(mag * (params.edgeIntensity * 0.3 + 0.1), 0.0, 1.0);
  // Smooth threshold so the black outline doesn't alias horribly.
  let edgeMask = smoothstep(0.15, 0.45, intensity);

  // Composite black outline over the posterised image.
  let out = posterized * (1.0 - edgeMask);
  let result = vec4f(out, src.a);

  if (maskFlags.hasMask != 0u) {
    let m = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    return mix(src, result, m);
  }
  return result;
}
