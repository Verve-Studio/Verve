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


struct BloomCompositeParams {
  strength : f32,
  _pad0    : f32,
  _pad1    : f32,
  _pad2    : f32,
}

@group(0) @binding(0) var srcTex       : texture_2d<f32>;
@group(0) @binding(1) var smp          : sampler;
@group(0) @binding(2) var glowTex      : texture_2d<f32>;
@group(0) @binding(3) var<uniform> params    : BloomCompositeParams;
@group(0) @binding(4) var selMask      : texture_2d<f32>;
@group(0) @binding(5) var<uniform> maskFlags : MaskFlags;

@fragment
fn fs_bloom_composite(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src  = textureSample(srcTex,  smp, in.uv);
  let glow = textureSample(glowTex, smp, in.uv);
  let g    = clamp(glow.rgb * params.strength, vec3f(0.0), vec3f(1.0));
  let out  = vec4f(1.0 - (1.0 - src.rgb) * (1.0 - g), src.a);

  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return mix(src, out, mask);
}
