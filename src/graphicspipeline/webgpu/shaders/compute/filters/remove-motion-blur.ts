// Richardson-Lucy GPU deconvolution for motion-blur removal.
// Three pipelines co-operate per iteration:
//   1. rmbPsf    — directional box average (same PSF as motion blur), writes rgba16float
//   2. rmbRatio  — per-pixel clamp(input / max(blurred, eps), 0, 8), writes rgba16float
//   3. rmbUpdate — per-pixel clamp(est * correction, 0, 1),           writes rgba16float
// Plus one final pipeline:
//   4. rmbFinal  — blend(estimate, input, blendBack),                  writes via render pass

import { ADJ_VERTEX_SHADER } from '../adjustments/helpers'

// ── PSF pass ─────────────────────────────────────────────────────────────────
// Same directional box-filter algorithm as the motion blur shader, but renders to
// rgba16float so intermediate estimates don't lose precision through 8-bit
// quantization. The srcTex binding accepts any f32-compatible format (rgba8unorm
// on the first iteration, rgba16float on subsequent ones).
export const FILTER_RMB_PSF_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
struct RmbPsfParams {
  angleDeg : f32,
  distance : u32,
  _pad0    : u32,
  _pad1    : u32,
}

@group(0) @binding(0) var srcTex           : texture_2d<f32>;
@group(0) @binding(1) var<uniform> params  : RmbPsfParams;

fn sampleBilinearPsf(coord: vec2f, dims: vec2u) -> vec4f {
  let c  = clamp(coord, vec2f(0.0), vec2f(f32(dims.x) - 1.0, f32(dims.y) - 1.0));
  let x0 = i32(c.x); let y0 = i32(c.y);
  let x1 = min(x0 + 1, i32(dims.x) - 1);
  let y1 = min(y0 + 1, i32(dims.y) - 1);
  let fx = c.x - f32(x0); let fy = c.y - f32(y0);
  return mix(
    mix(textureLoad(srcTex, vec2i(x0, y0), 0), textureLoad(srcTex, vec2i(x1, y0), 0), fx),
    mix(textureLoad(srcTex, vec2i(x0, y1), 0), textureLoad(srcTex, vec2i(x1, y1), 0), fx),
    fy,
  );
}

@fragment
fn fs_rmb_psf(in: AdjVertOut) -> @location(0) vec4<f32> {
  let dims  = textureDimensions(srcTex);
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let angle = params.angleDeg * 3.14159265358979 / 180.0;
  let stepX = cos(angle);
  let stepY = sin(angle);
  let dist  = params.distance;

  var sum = vec4f(0.0);
  for (var i = 0u; i < dist; i++) {
    let off = f32(i) - f32(dist - 1u) * 0.5;
    sum += sampleBilinearPsf(vec2f(f32(coord.x) + stepX * off, f32(coord.y) + stepY * off), dims);
  }
  return sum / f32(dist);
}
` as const

// ── Ratio pass ───────────────────────────────────────────────────────────────
// ratio = clamp(input / max(blurred_estimate, eps), 0, 8)
// Alpha is carried from inputTex unchanged (alpha correction is always 1).
export const FILTER_RMB_RATIO_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
@group(0) @binding(0) var inputTex   : texture_2d<f32>;  // original rgba8unorm layer
@group(0) @binding(1) var blurredTex : texture_2d<f32>;  // PSF(estimate) rgba16float

@fragment
fn fs_rmb_ratio(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let inp = textureLoad(inputTex,   coord, 0);
  let blr = textureLoad(blurredTex, coord, 0);
  let eps   = 1.0 / 255.0;
  // Clamp ratio to [0, 8] — prevents runaway amplification in very dark regions.
  let ratio = clamp(inp.rgb / max(blr.rgb, vec3f(eps)), vec3f(0.0), vec3f(8.0));
  // Use 1.0 for alpha so PSF(ratio) is 1.0 in the alpha channel everywhere.
  return vec4f(ratio, 1.0);
}
` as const

// ── Update pass ──────────────────────────────────────────────────────────────
// est_new = clamp(est * PSF(ratio), 0, 1)
// PSF(ratio) values live in [0, 8]; RL update amplifies bright regions and
// suppresses dark halos. Alpha is preserved from estTex.
export const FILTER_RMB_UPDATE_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
@group(0) @binding(0) var estTex  : texture_2d<f32>;  // current estimate
@group(0) @binding(1) var corrTex : texture_2d<f32>;  // PSF(ratio), range [0, 8]

@fragment
fn fs_rmb_update(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord   = vec2i(i32(in.pos.x), i32(in.pos.y));
  let est     = textureLoad(estTex,  coord, 0);
  let corr    = textureLoad(corrTex, coord, 0);
  let updated = clamp(est.rgb * corr.rgb, vec3f(0.0), vec3f(1.0));
  return vec4f(updated, est.a);
}
` as const

// ── Final blend pass ─────────────────────────────────────────────────────────
// Blends the deblurred estimate back toward the original (controlled by
// noiseReduction) and converts to the render target format. Alpha is always from
// inputTex (the original layer).
export const FILTER_RMB_FINAL_COMPUTE = /* wgsl */ `
${ADJ_VERTEX_SHADER}
struct RmbFinalParams {
  blendBack : f32,
  _pad0     : u32,
  _pad1     : u32,
  _pad2     : u32,
}

@group(0) @binding(0) var estTex           : texture_2d<f32>;  // rgba16float final estimate
@group(0) @binding(1) var inputTex         : texture_2d<f32>;  // original layer
@group(0) @binding(2) var<uniform> params  : RmbFinalParams;

@fragment
fn fs_rmb_final(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let est   = textureLoad(estTex,   coord, 0);
  let inp   = textureLoad(inputTex, coord, 0);
  let rgb   = clamp(mix(est.rgb, inp.rgb, params.blendBack), vec3f(0.0), vec3f(1.0));
  return vec4f(rgb, inp.a);
}
` as const
