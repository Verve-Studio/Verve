struct CheckerUniforms {
  tileSize   : f32,
  colorA     : vec3f,
  _pad0      : f32,
  colorB     : vec3f,
  _pad1      : f32,
  resolution : vec2f,
  _pad2      : vec2f,
}

struct VertexOutput {
  @builtin(position) pos : vec4f,
  @location(0)       uv  : vec2f,
}

@group(0) @binding(0) var<uniform> u : CheckerUniforms;

@vertex
fn vs_checker(@location(0) position: vec2f, @location(1) uv: vec2f) -> VertexOutput {
  var out: VertexOutput;
  out.pos = vec4f(
    position.x / u.resolution.x * 2.0 - 1.0,
    1.0 - position.y / u.resolution.y * 2.0,
    0.0, 1.0
  );
  out.uv = uv;
  return out;
}

@fragment
fn fs_checker(in: VertexOutput) -> @location(0) vec4f {
  let pos = floor(in.pos.xy / u.tileSize);
  let pattern = (u32(pos.x) + u32(pos.y)) % 2u;
  let col = select(u.colorA, u.colorB, pattern == 1u);
  return vec4f(col, 1.0);
}
