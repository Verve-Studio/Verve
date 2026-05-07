// Richardson-Lucy GPU deconvolution for motion-blur removal.
// Three pipelines co-operate per iteration:
//   1. rmbPsf    — directional box average (same PSF as motion blur), writes rgba16float
//   2. rmbRatio  — per-pixel clamp(input / max(blurred, eps), 0, 8), writes rgba16float
//   3. rmbUpdate — per-pixel clamp(est * correction, 0, 1),           writes rgba16float
// Plus one final pipeline:
//   4. rmbFinal  — blend(estimate, input, blendBack),                  writes via render pass

// ── PSF pass ─────────────────────────────────────────────────────────────────
// Same directional box-filter algorithm as the motion blur shader, but renders to
// rgba16float so intermediate estimates don't lose precision through 8-bit
// quantization. The srcTex binding accepts any f32-compatible format (rgba8unorm
// on the first iteration, rgba16float on subsequent ones).
// ── Ratio pass ───────────────────────────────────────────────────────────────
// ratio = clamp(input / max(blurred_estimate, eps), 0, 8)
// Alpha is carried from inputTex unchanged (alpha correction is always 1).
// ── Update pass ──────────────────────────────────────────────────────────────
// est_new = clamp(est * PSF(ratio), 0, 1)
// PSF(ratio) values live in [0, 8]; RL update amplifies bright regions and
// suppresses dark halos. Alpha is preserved from estTex.
// ── Final blend pass ─────────────────────────────────────────────────────────
// Blends the deblurred estimate back toward the original (controlled by
// noiseReduction) and converts to the render target format. Alpha is always from
// inputTex (the original layer).
