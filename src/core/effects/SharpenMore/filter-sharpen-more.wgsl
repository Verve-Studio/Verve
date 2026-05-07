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

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var smp    : sampler;

const kernel = array<f32, 9>(
  -1.0, -1.0, -1.0,
  -1.0,  9.0, -1.0,
  -1.0, -1.0, -1.0,
);

@fragment
fn fs_sharpen_more(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  var colorSum = vec4f(0.0);
  for (var ky = -1; ky <= 1; ky++) {
    for (var kx = -1; kx <= 1; kx++) {
      let sx = clamp(coord.x + kx, 0, i32(dims.x) - 1);
      let sy = clamp(coord.y + ky, 0, i32(dims.y) - 1);
      let k  = kernel[(ky + 1) * 3 + (kx + 1)];
      colorSum += textureLoad(srcTex, vec2i(sx, sy), 0) * k;
    }
  }
  let orig = textureLoad(srcTex, coord, 0);
  return vec4f(clamp(colorSum.rgb, vec3f(0.0), vec3f(1.0)), orig.a);
}
