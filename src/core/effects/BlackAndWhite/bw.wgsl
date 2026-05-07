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


struct BWParams {
  reds     : f32,
  yellows  : f32,
  greens   : f32,
  cyans    : f32,
  blues    : f32,
  magentas : f32,
  _pad     : vec2f,
}

@group(0) @binding(0) var srcTex   : texture_2d<f32>;
@group(0) @binding(1) var smp      : sampler;
@group(0) @binding(2) var<uniform> params    : BWParams;
@group(0) @binding(3) var selMask  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> maskFlags : MaskFlags;

@fragment
fn fs_black_and_white(in: AdjVertOut) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, smp, in.uv);
  if (src.a < 0.0001) { return src; }

  let hsl = rgb2hsl(src.rgb);
  let H = hsl.x; let S = hsl.y; let L = hsl.z;

  let wR = max(0.0, 1.0 - 6.0 * hueDist(H, 0.0 / 6.0));
  let wY = max(0.0, 1.0 - 6.0 * hueDist(H, 1.0 / 6.0));
  let wG = max(0.0, 1.0 - 6.0 * hueDist(H, 2.0 / 6.0));
  let wC = max(0.0, 1.0 - 6.0 * hueDist(H, 3.0 / 6.0));
  let wB = max(0.0, 1.0 - 6.0 * hueDist(H, 4.0 / 6.0));
  let wM = max(0.0, 1.0 - 6.0 * hueDist(H, 5.0 / 6.0));

  let uniformSlider = (params.reds + params.yellows + params.greens + params.cyans + params.blues + params.magentas) / 6.0;
  let hueBased      = wR * params.reds + wY * params.yellows + wG * params.greens
                    + wC * params.cyans + wB * params.blues  + wM * params.magentas;
  let satBlend      = clamp(S * 10.0, 0.0, 1.0);
  let weightedSlider = mix(uniformSlider, hueBased, satBlend);
  let gray = clamp(2.0 * L * weightedSlider / 100.0, 0.0, 1.0);

  let adjusted = vec4f(gray, gray, gray, src.a);
  var mask = 1.0f;
  if (maskFlags.hasMask != 0u) { mask = textureSampleLevel(selMask, smp, in.uv, 0.0).r; }
  return mix(src, adjusted, mask);
}
