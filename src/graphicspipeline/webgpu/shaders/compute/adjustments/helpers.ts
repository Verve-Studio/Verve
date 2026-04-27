// ─── Shared fullscreen-quad vertex shader ────────────────────────────────────
// Included at the top of every adjustment/filter fragment shader. Emits six
// vertices (two triangles) covering the entire framebuffer in clip space and
// passes interpolated UV coordinates (origin top-left, (1,1) bottom-right) to
// the fragment stage. No vertex buffers needed — positions are built from
// @builtin(vertex_index).
export const ADJ_VERTEX_SHADER = /* wgsl */ `
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
`

export const MASK_FLAGS_STRUCT = /* wgsl */ `
struct MaskFlags {
  hasMask : u32,
  _pad    : vec3u,
}
`

export const HSL_HELPERS = /* wgsl */ `
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
`

export const HUE_DIST = /* wgsl */ `
fn hueDist(h: f32, center: f32) -> f32 {
  let d = abs(h - center);
  return min(d, 1.0 - d);
}
`

export const OKLAB_HELPERS = /* wgsl */ `
fn srgb_to_linear(c: vec3f) -> vec3f {
  return select(c / 12.92,
                pow((c + 0.055) / 1.055, vec3f(2.4)),
                c > vec3f(0.04045));
}
fn linear_to_srgb(c: vec3f) -> vec3f {
  return select(c * 12.92,
                1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055,
                c > vec3f(0.0031308));
}
fn linear_srgb_to_oklab(c: vec3f) -> vec3f {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  let l_ = pow(max(l, 0.0), 1.0 / 3.0);
  let m_ = pow(max(m, 0.0), 1.0 / 3.0);
  let s_ = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3f(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  );
}
fn oklab_to_linear_srgb(lab: vec3f) -> vec3f {
  let l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  let m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  let s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return vec3f(
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  );
}
`
