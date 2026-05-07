struct OutlineMaskParams {
  mode  : u32,
  _pad0 : u32,
  _pad1 : u32,
  _pad2 : u32,
}

@group(0) @binding(0) var srcTex    : texture_2d<f32>;
@group(0) @binding(1) var morphATex : texture_2d<f32>;
@group(0) @binding(2) var morphBTex : texture_2d<f32>;
@group(0) @binding(3) var dstTex    : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var<uniform> params : OutlineMaskParams;

@compute @workgroup_size(8, 8)
fn cs_outline_mask(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(srcTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let coord = vec2i(id.xy);

  let src_alpha = textureLoad(srcTex,    coord, 0).a;
  let morph_a   = textureLoad(morphATex, coord, 0).r;
  let morph_b   = textureLoad(morphBTex, coord, 0).r;

  var mask: f32;
  if (params.mode == 0u) {
    mask = max(0.0, morph_a - src_alpha);
  } else if (params.mode == 1u) {
    mask = max(0.0, src_alpha - morph_b);
  } else {
    mask = max(0.0, morph_a - morph_b);
  }
  textureStore(dstTex, coord, vec4f(mask, 0.0, 0.0, 1.0));
}
