// ─── Seamless Texture – Pass 2: Seamless Border Blend ────────────────────────
// For each pixel near an image edge, blends with the pixel mirrored from the
// opposite edge, so that the image can tile without seams.
// Works on both horizontal and vertical axes independently then combines.

struct AdjVertOut {
  @builtin(position) pos : vec4f,
  @location(0)       uv  : vec2f,
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

struct BorderParams {
  imgWidth     : u32,
  imgHeight    : u32,
  borderRadiusX: u32,   // pixels — 0 disables X-axis blend
  borderRadiusY: u32,   // pixels — 0 disables Y-axis blend
  strength     : f32,   // 0..1 — peak mix amount at the edge
  _pad0        : f32,
  _pad1        : f32,
  _pad2        : f32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(2) var<uniform> params : BorderParams;

@fragment
fn fs_seamless_border(in: AdjVertOut) -> @location(0) vec4<f32> {
  let w   = f32(params.imgWidth);
  let h   = f32(params.imgHeight);
  let brX = f32(params.borderRadiusX);
  let brY = f32(params.borderRadiusY);
  let str = clamp(params.strength, 0.0, 1.0);
  let px  = vec2f(in.pos.xy);

  let ipx  = vec2i(i32(px.x), i32(px.y));
  let orig = textureLoad(srcTex, ipx, 0);

  // ── X-axis blend ──────────────────────────────────────────────────────────
  let distL = px.x;
  let distR = w - 1.0 - px.x;
  let edgeX = min(distL, distR);

  var blendX = 0.0;
  if (brX > 0.0) {
    blendX = clamp(1.0 - edgeX / brX, 0.0, 1.0);
    blendX = blendX * blendX * (3.0 - 2.0 * blendX);  // smoothstep
  }

  let ixMirrorX    = i32(w - 1.0 - px.x);
  let colorMirrorX = textureLoad(srcTex, vec2i(ixMirrorX, ipx.y), 0);

  let colorAfterX = mix(orig, colorMirrorX, blendX * str);

  // ── Y-axis blend ──────────────────────────────────────────────────────────
  let distT = px.y;
  let distB = h - 1.0 - px.y;
  let edgeY = min(distT, distB);

  var blendY = 0.0;
  if (brY > 0.0) {
    blendY = clamp(1.0 - edgeY / brY, 0.0, 1.0);
    blendY = blendY * blendY * (3.0 - 2.0 * blendY);
  }

  let iyMirrorY    = i32(h - 1.0 - px.y);
  let colorMirrorY = textureLoad(srcTex, vec2i(ipx.x, iyMirrorY), 0);

  let colorAfterY = mix(colorAfterX, colorMirrorY, blendY * str);

  return colorAfterY;
}
