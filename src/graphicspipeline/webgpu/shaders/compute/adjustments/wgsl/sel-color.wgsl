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


struct MaskFlags {
  hasMask : u32,
  _pad    : vec3u,
}


fn rgb2hsl(c: vec3f) -> vec3f {
  let maxC  = max(c.r, max(c.g, c.b));
  let minC  = min(c.r, min(c.g, c.b));
  let delta = maxC - minC;
  let L = (maxC + minC) * 0.5;
  var S = 0.0f;
  var H = 0.0f;
  if (delta > 0.00001) {
    S = delta / (1.0 - abs(2.0 * L - 1.0));
    if (maxC == c.r) {
      H = (c.g - c.b) / delta;
      H = H - floor(H / 6.0) * 6.0;
      H = H / 6.0;
    } else if (maxC == c.g) {
      H = ((c.b - c.r) / delta + 2.0) / 6.0;
    } else {
      H = ((c.r - c.g) / delta + 4.0) / 6.0;
    }
  }
  return vec3f(H, S, L);
}

fn hsl2rgb(hsl: vec3f) -> vec3f {
  let H = hsl.x; let S = hsl.y; let L = hsl.z;
  let C = (1.0 - abs(2.0 * L - 1.0)) * S;
  let h6 = H * 6.0;
  let X = C * (1.0 - abs(h6 - floor(h6 / 2.0) * 2.0 - 1.0));
  let m = L - C * 0.5;
  var rgb: vec3f;
  if      (h6 < 1.0) { rgb = vec3f(C, X, 0.0); }
  else if (h6 < 2.0) { rgb = vec3f(X, C, 0.0); }
  else if (h6 < 3.0) { rgb = vec3f(0.0, C, X); }
  else if (h6 < 4.0) { rgb = vec3f(0.0, X, C); }
  else if (h6 < 5.0) { rgb = vec3f(X, 0.0, C); }
  else               { rgb = vec3f(C, 0.0, X); }
  return clamp(rgb + m, vec3f(0.0), vec3f(1.0));
}


fn hueDist(h: f32, center: f32) -> f32 {
  let d = abs(h - center);
  return min(d, 1.0 - d);
}


struct SelectiveColorParams {
  cyan     : array<vec4f, 3>,   // 9 f32s packed as 3 × vec4f (last elem of [2] is padding)
  magenta  : array<vec4f, 3>,
  yellow   : array<vec4f, 3>,
  black    : array<vec4f, 3>,
  relative : u32,
}

fn scGetF32(arr: array<vec4f, 3>, i: u32) -> f32 {
  let vi = i / 4u;
  let ci = i % 4u;
  if (ci == 0u) { return arr[vi].x; }
  if (ci == 1u) { return arr[vi].y; }
  if (ci == 2u) { return arr[vi].z; }
  return arr[vi].w;
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var smp      : sampler;
@group(0) @binding(2) var<uniform> params    : SelectiveColorParams;
@group(0) @binding(3) var selMask  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

@fragment
fn fs_selective_color(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);
  if (src.a < 0.0001) { return src; }

  let rgb = src.rgb;
  let hsl = rgb2hsl(rgb);
  let H = hsl.x; let S = hsl.y; let L = hsl.z;

  let maxRGB = max(rgb.r, max(rgb.g, rgb.b));
  let K = 1.0 - maxRGB;
  var C = 0.0f; var M = 0.0f; var Y = 0.0f;
  if (K < 0.9999) {
    let denom = 1.0 - K;
    C = (1.0 - rgb.r - K) / denom;
    M = (1.0 - rgb.g - K) / denom;
    Y = (1.0 - rgb.b - K) / denom;
  }

  let satBlend = clamp(S * 10.0, 0.0, 1.0);

  var wR = max(0.0, 1.0 - 6.0 * hueDist(H, 0.0 / 6.0));
  var wY = max(0.0, 1.0 - 6.0 * hueDist(H, 1.0 / 6.0));
  var wG = max(0.0, 1.0 - 6.0 * hueDist(H, 2.0 / 6.0));
  var wC_h = max(0.0, 1.0 - 6.0 * hueDist(H, 3.0 / 6.0));
  var wB = max(0.0, 1.0 - 6.0 * hueDist(H, 4.0 / 6.0));
  var wM = max(0.0, 1.0 - 6.0 * hueDist(H, 5.0 / 6.0));

  let UNIFORM_W = 1.0 / 6.0;
  wR   = mix(UNIFORM_W, wR,   satBlend);
  wY   = mix(UNIFORM_W, wY,   satBlend);
  wG   = mix(UNIFORM_W, wG,   satBlend);
  wC_h = mix(UNIFORM_W, wC_h, satBlend);
  wB   = mix(UNIFORM_W, wB,   satBlend);
  wM   = mix(UNIFORM_W, wM,   satBlend);

  let wWhite   = clamp((L - 0.8) * 5.0, 0.0, 1.0);
  let wBlack   = clamp((0.2 - L) * 5.0, 0.0, 1.0);
  let wNeutral = clamp(1.0 - satBlend, 0.0, 1.0);

  var weights = array<f32, 9>(wR, wY, wG, wC_h, wB, wM, wWhite, wNeutral, wBlack);

  var dC = 0.0f; var dM_d = 0.0f; var dY_d = 0.0f; var dK_d = 0.0f;
  for (var i = 0u; i < 9u; i++) {
    let w = weights[i];
    if (params.relative != 0u) {
      dC   += w * (scGetF32(params.cyan,    i) / 100.0) * C;
      dM_d += w * (scGetF32(params.magenta, i) / 100.0) * M;
      dY_d += w * (scGetF32(params.yellow,  i) / 100.0) * Y;
      dK_d += w * (scGetF32(params.black,   i) / 100.0) * K;
    } else {
      dC   += w * (scGetF32(params.cyan,    i) / 100.0);
      dM_d += w * (scGetF32(params.magenta, i) / 100.0);
      dY_d += w * (scGetF32(params.yellow,  i) / 100.0);
      dK_d += w * (scGetF32(params.black,   i) / 100.0);
    }
  }

  let C2 = clamp(C + dC,   0.0, 1.0);
  let M2 = clamp(M + dM_d, 0.0, 1.0);
  let Y2 = clamp(Y + dY_d, 0.0, 1.0);
  let K2 = clamp(K + dK_d, 0.0, 1.0);

  let kComp = 1.0 - K2;
  let adjusted = vec4f((1.0-C2)*kComp, (1.0-M2)*kComp, (1.0-Y2)*kComp, src.a);
  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return mix(src, adjusted, mask);
}
