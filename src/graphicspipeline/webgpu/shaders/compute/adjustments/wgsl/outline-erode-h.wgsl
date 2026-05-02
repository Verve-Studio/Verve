struct OutlineMorphParams {
  radius : u32,
  _pad0  : u32,
  _pad1  : u32,
  _pad2  : u32,
}

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var dstTex : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params : OutlineMorphParams;

@compute @workgroup_size(8, 8)
fn cs_outline_erode_h(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(srcTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let r = i32(params.radius);
  var minA = 1.0;
  for (var dx: i32 = -r; dx <= r; dx++) {
    let sx = clamp(i32(id.x) + dx, 0, i32(dims.x) - 1);
    minA = min(minA, textureLoad(srcTex, vec2i(sx, i32(id.y)), 0).a);
  }
  textureStore(dstTex, vec2i(id.xy), vec4f(minA, 0.0, 0.0, 1.0));
}
