struct BevelParams {
  strength    : f32,
  lightAngle  : f32,
  heightScale : f32,
  _pad0       : f32,
}

struct MaskFlags {
  hasMask : u32,
  _pad    : vec3u,
}

@group(0) @binding(0) var srcTex    : texture_2d<f32>;
@group(0) @binding(1) var heightTex : texture_2d<f32>;
@group(0) @binding(2) var dstTex    : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> params    : BevelParams;
@group(0) @binding(4) var selMask  : texture_2d<f32>;
@group(0) @binding(5) var<uniform> maskFlags : MaskFlags;

@compute @workgroup_size(8, 8)
fn cs_bevel_composite(@builtin(global_invocation_id) id: vec3u) {
  let dims = vec2i(textureDimensions(srcTex));
  if (id.x >= u32(dims.x) || id.y >= u32(dims.y)) { return; }
  let coord = vec2i(id.xy);
  let src = textureLoad(srcTex, coord, 0);

  // Sample neighboring heights for finite-difference gradient
  let hL = textureLoad(heightTex, clamp(coord + vec2i(-1,  0), vec2i(0), dims - 1), 0).r;
  let hR = textureLoad(heightTex, clamp(coord + vec2i( 1,  0), vec2i(0), dims - 1), 0).r;
  let hT = textureLoad(heightTex, clamp(coord + vec2i( 0, -1), vec2i(0), dims - 1), 0).r;
  let hB = textureLoad(heightTex, clamp(coord + vec2i( 0,  1), vec2i(0), dims - 1), 0).r;

  let grad_x = (hR - hL) * 0.5 * params.heightScale;
  let grad_y = (hB - hT) * 0.5 * params.heightScale;

  // Surface normal from height field: (-dh/dx, -dh/dy, 1) normalised
  let N = normalize(vec3f(-grad_x, -grad_y, 1.0));

  // Light direction from angle (0° = right, 90° = down in image-space Y-down)
  let pi       = 3.14159265358979;
  let angleRad = params.lightAngle * pi / 180.0;
  let L        = normalize(vec3f(cos(angleRad), sin(angleRad), 0.6));

  // Only the *deviation* from a flat surface (where N=(0,0,1)) drives the effect.
  // On the flat interior/exterior, dot(N,L) == L.z, so the delta is zero → no change.
  let flatResponse = L.z;
  let diffuse      = dot(N, L) - flatResponse;
  let shapeMask    = src.a * params.strength;
  let highlight    = max(0.0,  diffuse) * shapeMask;
  let shadow       = max(0.0, -diffuse) * shapeMask * 0.7;

  // Highlight brightens toward white; shadow darkens toward black
  var outRGB = src.rgb + vec3f(highlight) * (1.0 - src.rgb) - vec3f(shadow) * src.rgb;
  outRGB     = clamp(outRGB, vec3f(0.0), vec3f(1.0));

  var out = vec4f(outRGB, src.a);

  if (maskFlags.hasMask != 0u) {
    let selA = textureLoad(selMask, coord, 0).r;
    out = mix(src, out, selA);
  }

  textureStore(dstTex, coord, out);
}
