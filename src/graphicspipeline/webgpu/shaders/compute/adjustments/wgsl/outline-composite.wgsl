struct OutlineCompositeParams {
  colorR  : f32,   // offset  0
  colorG  : f32,   // offset  4
  colorB  : f32,   // offset  8
  colorA  : f32,   // offset 12
  opacity : f32,   // offset 16
  _pad0   : u32,   // offset 20
  _pad1   : u32,   // offset 24
  _pad2   : u32,   // offset 28
}

struct MaskFlags {
  hasMask : u32,
  _pad    : vec3u,
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var maskTex  : texture_2d<f32>;
@group(0) @binding(2) var dstTex   : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> params    : OutlineCompositeParams;
@group(0) @binding(4) var selMask  : texture_2d<f32>;
@group(0) @binding(5) var<uniform> maskFlags : MaskFlags;

@compute @workgroup_size(8, 8)
fn cs_outline_composite(@builtin(global_invocation_id) id: vec3u) {
  let dims = vec2i(textureDimensions(srcTex));
  if (id.x >= u32(dims.x) || id.y >= u32(dims.y)) { return; }
  let coord = vec2i(id.xy);

  let src     = textureLoad(srcTex,  coord, 0);
  let rawMask = textureLoad(maskTex, coord, 0).r;

  let strokeA   = rawMask * params.colorA * params.opacity;
  let strokeRGB = vec3f(params.colorR, params.colorG, params.colorB);

  // Porter-Duff: src OVER stroke (stroke is behind source pixels)
  let outA   = src.a + strokeA * (1.0 - src.a);
  var outRGB = src.rgb * src.a + strokeRGB * strokeA * (1.0 - src.a);
  if (outA > 0.0001) { outRGB /= outA; }
  var out = vec4f(outRGB, outA);

  if (maskFlags.hasMask != 0u) {
    let selA = textureLoad(selMask, coord, 0).r;
    out = mix(src, out, selA);
  }

  textureStore(dstTex, coord, out);
}
