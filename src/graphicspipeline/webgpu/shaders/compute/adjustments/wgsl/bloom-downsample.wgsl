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


struct BloomDownsampleParams {
  scale : u32,
  _pad0 : u32,
  _pad1 : u32,
  _pad2 : u32,
}

@group(0) @binding(0) var srcTex  : texture_2d<f32>;
@group(0) @binding(1) var smp     : sampler;
@group(0) @binding(2) var<uniform> params : BloomDownsampleParams;

@fragment
fn fs_bloom_downsample(in: AdjVertOut) -> @location(0) vec4<f32> {
  let srcDims = textureDimensions(srcTex);
  let dstX    = i32(in.pos.x);
  let dstY    = i32(in.pos.y);
  let scale   = i32(params.scale);
  var acc     = vec4f(0.0);
  let count   = f32(scale * scale);

  for (var dy: i32 = 0; dy < scale; dy++) {
    for (var dx: i32 = 0; dx < scale; dx++) {
      let sx = clamp(dstX * scale + dx, 0, i32(srcDims.x) - 1);
      let sy = clamp(dstY * scale + dy, 0, i32(srcDims.y) - 1);
      acc += textureLoad(srcTex, vec2i(sx, sy), 0);
    }
  }
  return acc / count;
}
