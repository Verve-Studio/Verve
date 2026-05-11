const K : u32 = 5u;
const LAMBDA : f32 = 675.0;  // 9 * GAMMA(75) — must match grabcut.cpp
const NLL_FALLBACK : f32 = 30.0;
const PI_EPS : f32 = 1e-8;

struct Comp {
  mean    : vec3<f32>,
  invCov0 : vec3<f32>,
  invCov1 : vec3<f32>,
  invCov2 : vec3<f32>,
  logCoef : f32,
  pi      : f32,
  _pad    : vec2<f32>,
}

struct Gmm {
  fg : array<Comp, 5>,
  bg : array<Comp, 5>,
}

struct Dims {
  w   : u32,
  h   : u32,
  _p0 : u32,
  _p1 : u32,
}

@group(0) @binding(0) var srcTex    : texture_2d<f32>;
@group(0) @binding(1) var trimapTex : texture_2d<u32>;
@group(0) @binding(2) var<uniform> dims : Dims;
@group(0) @binding(3) var<uniform> gmm  : Gmm;
@group(0) @binding(4) var<storage, read_write> capS : array<f32>;
@group(0) @binding(5) var<storage, read_write> capT : array<f32>;

fn comp_mahal(c: Comp, d: vec3<f32>) -> f32 {
  let mx = dot(c.invCov0, d);
  let my = dot(c.invCov1, d);
  let mz = dot(c.invCov2, d);
  return d.x * mx + d.y * my + d.z * mz;
}

fn nll_fg(x: vec3<f32>) -> f32 {
  var maxLg : f32 = -1e30;
  for (var i = 0u; i < K; i = i + 1u) {
    let c = gmm.fg[i];
    if (c.pi >= PI_EPS) {
      let d = x - c.mean;
      let lg = c.logCoef - 0.5 * comp_mahal(c, d);
      if (lg > maxLg) { maxLg = lg; }
    }
  }
  if (maxLg < -1e29) { return NLL_FALLBACK; }
  var s : f32 = 0.0;
  for (var i = 0u; i < K; i = i + 1u) {
    let c = gmm.fg[i];
    if (c.pi >= PI_EPS) {
      let d = x - c.mean;
      let lg = c.logCoef - 0.5 * comp_mahal(c, d);
      s = s + exp(lg - maxLg);
    }
  }
  return -(maxLg + log(s));
}

fn nll_bg(x: vec3<f32>) -> f32 {
  var maxLg : f32 = -1e30;
  for (var i = 0u; i < K; i = i + 1u) {
    let c = gmm.bg[i];
    if (c.pi >= PI_EPS) {
      let d = x - c.mean;
      let lg = c.logCoef - 0.5 * comp_mahal(c, d);
      if (lg > maxLg) { maxLg = lg; }
    }
  }
  if (maxLg < -1e29) { return NLL_FALLBACK; }
  var s : f32 = 0.0;
  for (var i = 0u; i < K; i = i + 1u) {
    let c = gmm.bg[i];
    if (c.pi >= PI_EPS) {
      let d = x - c.mean;
      let lg = c.logCoef - 0.5 * comp_mahal(c, d);
      s = s + exp(lg - maxLg);
    }
  }
  return -(maxLg + log(s));
}

@compute @workgroup_size(8, 8)
fn cs_dataterms(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= dims.w || id.y >= dims.h) { return; }
  let idx = id.y * dims.w + id.x;
  let c = textureLoad(srcTex, vec2<i32>(i32(id.x), i32(id.y)), 0).rgb;
  let tri = textureLoad(trimapTex, vec2<i32>(i32(id.x), i32(id.y)), 0).r;
  var cs : f32;
  var ct : f32;
  if (tri == 255u) {
    cs = LAMBDA;
    ct = 0.0;
  } else if (tri == 0u) {
    cs = 0.0;
    ct = LAMBDA;
  } else {
    cs = nll_bg(c);
    ct = nll_fg(c);
  }
  capS[idx] = cs;
  capT[idx] = ct;
}
