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



struct BloomExtractParams {
  threshold : f32,
  _pad0     : f32,
  _pad1     : f32,
  _pad2     : f32,
}

@group(0) @binding(0) var srcTex     : texture_2d<f32>;
@group(0) @binding(1) var smp        : sampler;
@group(0) @binding(2) var<uniform> params    : BloomExtractParams;
@group(0) @binding(3) var selMask    : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

@fragment
fn fs_bloom_extract(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);

  let lum = dot(src.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let t   = params.threshold;
  let k   = 0.1;
  let w   = smoothstep(t - k, t + k, lum);
  let glow = vec4f(src.rgb * w, src.a * w);

  var out = glow;
  if (maskFlags.hasMask != 0u) {
    let mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    out = glow * mask;
  }
  return out;
}
