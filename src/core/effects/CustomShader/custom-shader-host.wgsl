// Host for node-graph shaders. CustomShaderEffect appends the graph's
// uniform declaration (`ng_u`, binding 2) and its compiled `ng_shade`
// function (see src/core/nodes/shaderCompiler.ts) to this source.

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

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var smp    : sampler;
@group(0) @binding(3) var selMask : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

// Texel fetch at integer canvas pixel `p`, clamped to the edge. Filtering
// and edge modes are built on this by the compiled graph's helpers.
fn ng_load(p: vec2i) -> vec4f {
  let mx = vec2i(textureDimensions(srcTex)) - vec2i(1, 1);
  return textureLoad(srcTex, clamp(p, vec2i(0, 0), mx), 0);
}

@fragment
fn fs_custom_shader(in: AdjVertOut) -> @location(0) vec4f {
  let dimsU = textureDimensions(srcTex);
  let src = textureLoad(srcTex, vec2i(in.pos.xy), 0);
  let result = ng_shade(in.uv, in.uv * vec2f(f32(dimsU.x), f32(dimsU.y)), src);
  if (maskFlags.hasMask != 0u) {
    let mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    return mix(src, result, mask);
  }
  return result;
}
