struct InnerShadowParams {
  colorR  : f32,
  colorG  : f32,
  colorB  : f32,
  colorA  : f32,
  opacity : f32,
  offsetX : i32,
  offsetY : i32,
  _pad    : f32,
}

struct MaskFlags {
  hasMask : u32,
  _pad    : vec3u,
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var maskTex  : texture_2d<f32>;
@group(0) @binding(2) var dstTex   : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> params    : InnerShadowParams;
@group(0) @binding(4) var selMask  : texture_2d<f32>;
@group(0) @binding(5) var<uniform> maskFlags : MaskFlags;

@compute @workgroup_size(8, 8)
fn cs_inner_shadow_composite(@builtin(global_invocation_id) id: vec3u) {
  let dims  = vec2i(textureDimensions(srcTex));
  if (id.x >= u32(dims.x) || id.y >= u32(dims.y)) { return; }
  let coord = vec2i(id.xy);
  let src   = textureLoad(srcTex, coord, 0);

  // Sample blurred-eroded mask shifted by offset.
  // Where erodedAlpha is LOW (near interior edges), shadow is STRONG.
  let sampleCoord = coord - vec2i(params.offsetX, params.offsetY);
  var erodedAlpha = 0.0;
  if (all(sampleCoord >= vec2i(0)) && all(sampleCoord < dims)) {
    erodedAlpha = textureLoad(maskTex, sampleCoord, 0).r;
  }

  // Shadow intensity: increases toward shape edges, clipped to source alpha
  var shadowIntensity = (1.0 - erodedAlpha) * src.a * params.colorA * params.opacity;
  shadowIntensity     = clamp(shadowIntensity, 0.0, 1.0);

  // Blend shadow colour on top of source; alpha unchanged (inner shadow stays inside)
  let shadowColor = vec3f(params.colorR, params.colorG, params.colorB);
  let outRGB      = mix(src.rgb, shadowColor, shadowIntensity);
  let outA        = src.a;

  var out = vec4f(outRGB, outA);

  if (maskFlags.hasMask != 0u) {
    let selA = textureLoad(selMask, coord, 0).r;
    out = mix(src, out, selA);
  }

  textureStore(dstTex, coord, out);
}
