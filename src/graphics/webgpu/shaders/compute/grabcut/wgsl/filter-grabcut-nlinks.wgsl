struct Params {
  w     : u32,
  h     : u32,
  beta  : f32,
  gamma : f32,
}

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> hW : array<f32>;
@group(0) @binding(2) var<storage, read_write> vW : array<f32>;
@group(0) @binding(3) var<uniform> params : Params;

@compute @workgroup_size(8, 8)
fn cs_nlinks(@builtin(global_invocation_id) id: vec3u) {
  let x = id.x;
  let y = id.y;
  if (x >= params.w || y >= params.h) { return; }
  let c0 = textureLoad(srcTex, vec2<i32>(i32(x), i32(y)), 0).rgb;
  if (x + 1u < params.w) {
    let c1 = textureLoad(srcTex, vec2<i32>(i32(x) + 1, i32(y)), 0).rgb;
    let d = c0 - c1;
    let sq = dot(d, d);
    hW[y * (params.w - 1u) + x] = params.gamma * exp(-params.beta * sq);
  }
  if (y + 1u < params.h) {
    let c1 = textureLoad(srcTex, vec2<i32>(i32(x), i32(y) + 1), 0).rgb;
    let d = c0 - c1;
    let sq = dot(d, d);
    vW[y * params.w + x] = params.gamma * exp(-params.beta * sq);
  }
}
