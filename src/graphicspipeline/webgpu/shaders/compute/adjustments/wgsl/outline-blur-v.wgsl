struct OutlineBlurParams {
  radius : u32,
  _pad0  : u32,
  _pad1  : u32,
  _pad2  : u32,
}

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var dstTex : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params : OutlineBlurParams;

@compute @workgroup_size(8, 8)
fn cs_outline_blur_v(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(srcTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let r = i32(params.radius);
  let count = f32(2 * r + 1);
  var acc = 0.0;
  for (var dy: i32 = -r; dy <= r; dy++) {
    let sy = clamp(i32(id.y) + dy, 0, i32(dims.y) - 1);
    acc += textureLoad(srcTex, vec2i(i32(id.x), sy), 0).r;
  }
  textureStore(dstTex, vec2i(id.xy), vec4f(acc / count, 0.0, 0.0, 1.0));
}
