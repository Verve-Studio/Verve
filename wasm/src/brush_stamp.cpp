// brush_stamp.cpp
//
// Implementation notes:
//   * Coordinate transform mirrors `applyStamp` in stampEngine.ts. We
//     intentionally skip motion-blur elongation here — the JS path
//     handles that case (rare, and the inverse rotate-shrink-rotate is
//     awkward to fold into the inner loop without a dynamic branch).
//   * sRGB→linear conversion for rgba32f writes is done JS-side: the
//     caller passes already-linear `fr/fg/fb`. This matches what the
//     JS `applyStamp` does (it precomputes `srcFloat` once per stamp).
//   * The cap-flow Porter-Duff math matches `blendPixelOver`, byte
//     identical including the 0.5 nearest-rounding offset on the
//     touched-buffer write.

#include "brush_stamp.h"
#include <cmath>
#include <algorithm>

#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

namespace {

inline float sample_sdf_round(float u, float v) {
    return std::sqrt(u * u + v * v) - 1.0f;
}
inline float sample_sdf_square(float u, float v) {
    float au = std::fabs(u), av = std::fabs(v);
    return (au > av ? au : av) - 1.0f;
}
inline float sample_sdf_diamond(float u, float v) {
    return std::fabs(u) + std::fabs(v) - 1.0f;
}

// Bilinear bitmap-SDF sample. Mirrors BitmapSdfSampler.sample() — unit
// space (-1..1) maps to pixel space centred on the bitmap, scaled so the
// longer half-edge is the unit. Returns distance in unit-space (caller
// multiplies by radius for canvas-pixel distance).
inline float sample_sdf_bitmap(
    const float* sdf, int w, int h, float u, float v
) {
    float halfMax = (float)(w > h ? w : h) * 0.5f;
    float unitScale = 1.0f / halfMax;
    float px = u * halfMax + (float)w * 0.5f - 0.5f;
    float py = v * halfMax + (float)h * 0.5f - 0.5f;

    int x0 = (int)std::floor(px);
    int y0 = (int)std::floor(py);
    int x1 = x0 + 1;
    int y1 = y0 + 1;
    float fx = px - (float)x0;
    float fy = py - (float)y0;

    if (x1 < 0 || y1 < 0 || x0 >= w || y0 >= h) {
        // Out-of-bounds: large positive proportional to centre distance.
        float cx = (float)w * 0.5f, cy = (float)h * 0.5f;
        float dx = px - cx, dy = py - cy;
        return std::sqrt(dx * dx + dy * dy) * unitScale;
    }
    int cx0 = x0 < 0 ? 0 : (x0 >= w ? w - 1 : x0);
    int cy0 = y0 < 0 ? 0 : (y0 >= h ? h - 1 : y0);
    int cx1 = x1 < 0 ? 0 : (x1 >= w ? w - 1 : x1);
    int cy1 = y1 < 0 ? 0 : (y1 >= h ? h - 1 : y1);

    float s00 = sdf[cy0 * w + cx0];
    float s10 = sdf[cy0 * w + cx1];
    float s01 = sdf[cy1 * w + cx0];
    float s11 = sdf[cy1 * w + cx1];
    float sxy =
        s00 * (1.0f - fx) * (1.0f - fy) +
        s10 * fx * (1.0f - fy) +
        s01 * (1.0f - fx) * fy +
        s11 * fx * fy;
    return sxy * unitScale;
}

inline int mod_pos(int v, int m) {
    int r = v % m;
    return r < 0 ? r + m : r;
}

// Quantised round-to-nearest, matching the `(x * 255 + 0.5) | 0` JS
// idiom we use in primitives.ts (clamps below to 0 via the >= 0 input
// guarantee from Porter-Duff math).
inline uint8_t to_byte_nearest(float x) {
    if (x <= 0.0f) return 0;
    if (x >= 1.0f) return 255;
    return (uint8_t)(x * 255.0f + 0.5f);
}

// ── Paper grain: value-noise lattice ──────────────────────────────────
// Direct port of `paperTexture.ts`. Mirrors the JS hash exactly so the
// noise pattern is byte-identical between the WASM and JS paths — same
// brush rendered through either backend produces the same image.
inline float hash2_grain(int ix, int iy) {
    uint32_t h = ((uint32_t)ix * 0x27d4eb2du) ^ ((uint32_t)iy * 0x165667b1u);
    h ^= h >> 15;
    h *= 0x2c1b3c6du;
    h ^= h >> 12;
    h *= 0x297a2d39u;
    h ^= h >> 15;
    return (float)h * (1.0f / 4294967296.0f);
}
inline float smoothstep_t(float t) { return t * t * (3.0f - 2.0f * t); }
inline float value_noise(float x, float y, float period) {
    const float u = x / period;
    const float v = y / period;
    const float ixF = std::floor(u);
    const float iyF = std::floor(v);
    const int ix = (int)ixF;
    const int iy = (int)iyF;
    const float fx = smoothstep_t(u - ixF);
    const float fy = smoothstep_t(v - iyF);
    const float h00 = hash2_grain(ix, iy);
    const float h10 = hash2_grain(ix + 1, iy);
    const float h01 = hash2_grain(ix, iy + 1);
    const float h11 = hash2_grain(ix + 1, iy + 1);
    const float a = h00 * (1.0f - fx) + h10 * fx;
    const float b = h01 * (1.0f - fx) + h11 * fx;
    return a * (1.0f - fy) + b * fy;
}
inline float sample_grain(float x, float y, float amount, float scale) {
    if (amount <= 0.0f) return 1.0f;
    const float p = scale < 2.0f ? 2.0f : scale;
    const float n = value_noise(x, y, p);
    return 1.0f - amount * (1.0f - n);
}

// ── Dual-brush per-pixel coverage modulation ──────────────────────────
// Mirrors the JS code in stampEngine.ts inner loop. Returns the multiplier
// to apply to the primary tip's coverage. dual_active is assumed true
// upstream — we don't gate here.
inline float sample_dual_modulation(
    float dxBase0, float dyBase0,
    float dualCosT, float dualSinT,
    float dualInvR, float dualRadius, float dualMix,
    int dualTipKind,
    const float* dualSdf, int dualSdfW, int dualSdfH
) {
    const float dlx = dxBase0 * dualCosT + dyBase0 * dualSinT;
    const float dly = -dxBase0 * dualSinT + dyBase0 * dualCosT;
    const float du = dlx * dualInvR;
    const float dv = dly * dualInvR;
    float ddist;
    switch (dualTipKind) {
        case 0: ddist = sample_sdf_round(du, dv) * dualRadius; break;
        case 1: ddist = sample_sdf_square(du, dv) * dualRadius; break;
        case 2: ddist = sample_sdf_diamond(du, dv) * dualRadius; break;
        case 3: ddist = sample_sdf_bitmap(dualSdf, dualSdfW, dualSdfH, du, dv) * dualRadius; break;
        default: return 1.0f;
    }
    // Half-pixel AA across the dual silhouette (matches JS).
    float dCov;
    if (ddist <= -0.5f) dCov = 1.0f;
    else if (ddist >= 0.5f) dCov = 0.0f;
    else dCov = 0.5f - ddist;
    return 1.0f - dualMix + dualMix * dCov;
}

} // anonymous namespace

extern "C" void brush_stamp(
    const BrushStampParams* p,
    void*                   layer_data,
    uint8_t*                touched_data,
    const uint8_t*          sel_mask,
    const float*            sdf_data,
    int                     sdf_w,
    int                     sdf_h,
    const float*            dual_sdf_data,
    int                     dual_sdf_w,
    int                     dual_sdf_h
) {
    const float radius = p->radius;
    if (radius < 0.5f) return;
    const float invRadius  = 1.0f / radius;
    const float invRadiusY = 1.0f / (radius * (p->roundness > 0.0f ? p->roundness : 1.0f));
    const float cosT = std::cos(p->angle);
    const float sinT = std::sin(p->angle);
    const float cx = p->cx, cy = p->cy;
    const float aaWidth = p->aa_width;
    const float shear = p->shear;
    const float fxFlip = (float)p->flip_x;
    const float fyFlip = (float)p->flip_y;
    const int tipKind = p->tip_kind;

    const int layerOX = p->layer_offset_x;
    const int layerOY = p->layer_offset_y;
    const int layerW  = p->layer_w;
    const int layerH  = p->layer_h;
    const int touchedW = p->touched_w;
    const int canvasW  = touchedW;
    const int canvasH  = p->touched_h;

    const float opacity    = p->opacity;
    const float capOpacity = p->cap_opacity;
    const bool  hasCap     = capOpacity >= 0.0f;
    const bool  bypassCap  = p->bypass_cap != 0;
    const bool  tiled      = p->tiled != 0;
    const int   tiledW     = p->tiled_w;
    const int   tiledH     = p->tiled_h;

    const bool isF32 = p->layer_format == 1;
    uint8_t* layerBytes = isF32 ? nullptr : (uint8_t*)layer_data;
    float*   layerF32   = isF32 ? (float*)layer_data : nullptr;

    // Per-stamp colour (rgba8 path uses bytes; rgba32f uses floats).
    const int rByte = p->r, gByte = p->g, bByte = p->b, aByte = p->a;
    const float fr = p->fr, fg = p->fg, fb = p->fb, fa = p->fa;
    // a/255 used by both the srcA and capA computations.
    const float aFraction = (float)aByte * (1.0f / 255.0f);

    // Pre-compute the pre-cap srcA and capA factors that don't depend on
    // per-pixel coverage. The per-pixel `opacity` arg in JS is "stamp
    // deposit including coverage" — here we keep them separate: opacity
    // (constant) × coverage (per pixel) on the way in.
    const float srcAlphaScale = (isF32 ? fa : aFraction) * (opacity * 0.01f);
    const float capAlphaScale = hasCap
        ? (isF32 ? fa : aFraction) * (capOpacity * 0.01f)
        : 0.0f;
    const float bypassGeomScale = opacity * 0.01f;

    // ── Dual brush per-stamp setup ─────────────────────────────────────
    const float dualRadius = p->dual_active ? radius * p->dual_size_ratio : 0.0f;
    const bool  dualOn     = p->dual_active != 0 && dualRadius >= 0.5f && p->dual_mix > 0.0f;
    const float dualInvR   = dualOn ? 1.0f / dualRadius : 0.0f;
    const float dualCosT   = dualOn ? std::cos(p->dual_base_angle) : 1.0f;
    const float dualSinT   = dualOn ? std::sin(p->dual_base_angle) : 0.0f;
    const float dualMix    = dualOn ? (p->dual_mix < 0.0f ? 0.0f : (p->dual_mix > 1.0f ? 1.0f : p->dual_mix)) : 0.0f;
    const int   dualTipKind = p->dual_tip_kind;

    // ── Paper grain per-stamp setup ────────────────────────────────────
    const bool  grainOn      = p->grain_amount > 0.0f;
    const float grainAmount  = p->grain_amount;
    const float grainScale   = p->grain_scale < 2.0f ? 2.0f : p->grain_scale;
    const bool  grainFollows = p->grain_follow_brush != 0;

#ifdef __wasm_simd128__
    // ── SIMD fast path ──────────────────────────────────────────────────
    // Vectorise the per-pixel transform + SDF sample + AA coverage for
    // 4 consecutive pixels along x. The touched check + Porter-Duff
    // blend stay scalar — they have too many "skip this lane" branches
    // (sel-mask, layer-bounds, cap-reached) to vectorise without losing
    // more on mask juggling than we'd gain on the FP work. Textbook
    // hybrid: SIMD the wide compute, scalarise the narrow scatter.
    //
    // Eligible tip kinds: round / square / diamond. Bitmap stays scalar
    // (would need SIMD gather, which WASM SIMD doesn't have). Smudge
    // (`bypass_cap`) and tiled-mode also stay scalar.
    const bool simdHotPath = !bypassCap && tipKind != 3 && !tiled;
    if (simdHotPath) {
        const v128_t vCx        = wasm_f32x4_splat(cx);
        const v128_t vCy        = wasm_f32x4_splat(cy);
        const v128_t vCosT      = wasm_f32x4_splat(cosT);
        const v128_t vSinT      = wasm_f32x4_splat(sinT);
        const v128_t vNegSinT   = wasm_f32x4_splat(-sinT);
        const v128_t vShear     = wasm_f32x4_splat(shear);
        const v128_t vFxFlip    = wasm_f32x4_splat(fxFlip);
        const v128_t vFyFlip    = wasm_f32x4_splat(fyFlip);
        const v128_t vInvR      = wasm_f32x4_splat(invRadius);
        const v128_t vInvRY     = wasm_f32x4_splat(invRadiusY);
        const v128_t vRadius    = wasm_f32x4_splat(radius);
        const v128_t vAaWidth   = wasm_f32x4_splat(aaWidth);
        const v128_t vTwoAa     = wasm_f32x4_splat(2.0f * aaWidth);
        const v128_t vOne       = wasm_f32x4_splat(1.0f);
        const v128_t vZero      = wasm_f32x4_splat(0.0f);
        const v128_t vThree     = wasm_f32x4_splat(3.0f);
        const v128_t vTwo       = wasm_f32x4_splat(2.0f);
        // Per-lane offsets [0,1,2,3] added to base px.
        const v128_t vLaneOff   = wasm_f32x4_make(0.0f, 1.0f, 2.0f, 3.0f);

        for (int py = p->min_y; py <= p->max_y; py++) {
            const v128_t vDyBase0 = wasm_f32x4_sub(
                wasm_f32x4_splat((float)py), vCy);
            int px = p->min_x;
            for (; px + 3 <= p->max_x; px += 4) {
                const v128_t vPx = wasm_f32x4_add(
                    wasm_f32x4_splat((float)px), vLaneOff);
                const v128_t vDxBase0 = wasm_f32x4_sub(vPx, vCx);

                v128_t vLx = wasm_f32x4_add(
                    wasm_f32x4_mul(vDxBase0, vCosT),
                    wasm_f32x4_mul(vDyBase0, vSinT));
                v128_t vLy = wasm_f32x4_add(
                    wasm_f32x4_mul(vDxBase0, vNegSinT),
                    wasm_f32x4_mul(vDyBase0, vCosT));
                vLx = wasm_f32x4_sub(vLx, wasm_f32x4_mul(vShear, vLy));
                vLx = wasm_f32x4_mul(vLx, vFxFlip);
                vLy = wasm_f32x4_mul(vLy, vFyFlip);
                const v128_t vU = wasm_f32x4_mul(vLx, vInvR);
                const v128_t vV = wasm_f32x4_mul(vLy, vInvRY);

                // SDF — branch on tipKind (constant per call; branch
                // predictor pins it, no measurable cost).
                v128_t vDist;
                if (tipKind == 0) {
                    const v128_t vR2 = wasm_f32x4_add(
                        wasm_f32x4_mul(vU, vU),
                        wasm_f32x4_mul(vV, vV));
                    vDist = wasm_f32x4_mul(
                        wasm_f32x4_sub(wasm_f32x4_sqrt(vR2), vOne),
                        vRadius);
                } else if (tipKind == 1) {
                    vDist = wasm_f32x4_mul(
                        wasm_f32x4_sub(
                            wasm_f32x4_max(
                                wasm_f32x4_abs(vU), wasm_f32x4_abs(vV)),
                            vOne),
                        vRadius);
                } else {
                    vDist = wasm_f32x4_mul(
                        wasm_f32x4_sub(
                            wasm_f32x4_add(
                                wasm_f32x4_abs(vU), wasm_f32x4_abs(vV)),
                            vOne),
                        vRadius);
                }

                v128_t vCoverage;
                if (aaWidth > 0.0f) {
                    const v128_t vT = wasm_f32x4_div(
                        wasm_f32x4_sub(vAaWidth, vDist), vTwoAa);
                    const v128_t vTPos    = wasm_f32x4_gt(vT, vZero);
                    const v128_t vTGe1    = wasm_f32x4_ge(vT, vOne);
                    // Clamp t→1 where t≥1; smoothstep on the clamped value.
                    const v128_t vTClamped = wasm_v128_bitselect(vOne, vT, vTGe1);
                    const v128_t vSmooth = wasm_f32x4_mul(
                        wasm_f32x4_mul(vTClamped, vTClamped),
                        wasm_f32x4_sub(vThree, wasm_f32x4_mul(vTwo, vTClamped)));
                    // Zero out lanes where t≤0.
                    vCoverage = wasm_v128_bitselect(vSmooth, vZero, vTPos);
                } else {
                    const v128_t vInside = wasm_f32x4_le(vDist, vZero);
                    vCoverage = wasm_v128_bitselect(vOne, vZero, vInside);
                }

                // Whole-group early-out at bbox corners — most stamps are
                // disc-shaped so the corners of the bbox have zero
                // coverage in all 4 lanes.
                const v128_t vActive = wasm_f32x4_gt(vCoverage, vZero);
                if (!wasm_v128_any_true(vActive)) continue;

                // Spill lane coverage to scalar; the per-lane blend keeps
                // its branchy structure.
                alignas(16) float lane_cov[4];
                wasm_v128_store(lane_cov, vCoverage);

                for (int lane = 0; lane < 4; lane++) {
                    float coverage = lane_cov[lane];
                    if (coverage <= 0.0f) continue;
                    const int cxPx = px + lane;
                    const int cyPx = py;
                    if (cxPx < 0 || cxPx >= canvasW ||
                        cyPx < 0 || cyPx >= canvasH) continue;
                    if (sel_mask && sel_mask[cyPx * canvasW + cxPx] == 0) continue;

                    // Grain + dual modulation. Computed per-pixel because
                    // the SDF samples need the actual lane (px+lane) and
                    // dxBase0/dyBase0 — same scalar math as the JS path
                    // and the kernel's scalar fallback below.
                    if (grainOn || dualOn) {
                        const float dxBase0 = (float)cxPx - cx;
                        const float dyBase0 = (float)cyPx - cy;
                        if (grainOn) {
                            // followBrush: sample in tip-local; otherwise
                            // canvas-locked. Tip-local coords are the
                            // already-rotated lx/ly — recompute them
                            // (cheap; no trig, just the same rotation).
                            float gx, gy;
                            if (grainFollows) {
                                float lx = dxBase0 * cosT + dyBase0 * sinT;
                                float ly = -dxBase0 * sinT + dyBase0 * cosT;
                                lx -= shear * ly;
                                lx *= fxFlip;
                                ly *= fyFlip;
                                gx = lx;
                                gy = ly;
                            } else {
                                gx = (float)cxPx;
                                gy = (float)cyPx;
                            }
                            coverage *= sample_grain(gx, gy, grainAmount, grainScale);
                        }
                        if (dualOn) {
                            coverage *= sample_dual_modulation(
                                dxBase0, dyBase0,
                                dualCosT, dualSinT, dualInvR, dualRadius, dualMix,
                                dualTipKind, dual_sdf_data, dual_sdf_w, dual_sdf_h);
                        }
                        if (coverage <= 0.0f) continue;
                    }

                    const int lxLocal = cxPx - layerOX;
                    const int lyLocal = cyPx - layerOY;
                    if (lxLocal < 0 || lxLocal >= layerW ||
                        lyLocal < 0 || lyLocal >= layerH) continue;

                    const int touchedKey = cyPx * touchedW + cxPx;
                    const uint8_t existingByte = touched_data[touchedKey];
                    const float existingA = (float)existingByte * (1.0f / 255.0f);

                    const float srcA = srcAlphaScale * coverage;
                    if (srcA <= 0.0f) continue;

                    float blendA;
                    if (hasCap) {
                        const float capA = capAlphaScale * coverage;
                        if (existingA >= capA) continue;
                        const float upgrade = existingA < 1.0f
                            ? (capA - existingA) / (1.0f - existingA)
                            : 0.0f;
                        blendA = srcA < upgrade ? srcA : upgrade;
                        if (blendA <= 0.0f) continue;
                        const float newA = existingA + blendA * (1.0f - existingA);
                        touched_data[touchedKey] = to_byte_nearest(newA);
                    } else {
                        if (srcA <= existingA) continue;
                        blendA = existingA < 1.0f
                            ? (srcA - existingA) / (1.0f - existingA)
                            : 0.0f;
                        if (blendA <= 0.0f) continue;
                        touched_data[touchedKey] = to_byte_nearest(srcA);
                    }

                    const int pixelIdx = (lyLocal * layerW + lxLocal) * 4;
                    if (isF32) {
                        const float er = layerF32[pixelIdx + 0];
                        const float eg = layerF32[pixelIdx + 1];
                        const float eb = layerF32[pixelIdx + 2];
                        const float ea = layerF32[pixelIdx + 3];
                        const float dstBlend = ea * (1.0f - blendA);
                        const float outA = blendA + dstBlend;
                        if (outA <= 0.0f) {
                            layerF32[pixelIdx + 0] = 0.0f;
                            layerF32[pixelIdx + 1] = 0.0f;
                            layerF32[pixelIdx + 2] = 0.0f;
                            layerF32[pixelIdx + 3] = 0.0f;
                        } else {
                            const float invOutA = 1.0f / outA;
                            layerF32[pixelIdx + 0] = (fr * blendA + er * dstBlend) * invOutA;
                            layerF32[pixelIdx + 1] = (fg * blendA + eg * dstBlend) * invOutA;
                            layerF32[pixelIdx + 2] = (fb * blendA + eb * dstBlend) * invOutA;
                            layerF32[pixelIdx + 3] = outA;
                        }
                    } else {
                        const int er = layerBytes[pixelIdx + 0];
                        const int eg = layerBytes[pixelIdx + 1];
                        const int eb = layerBytes[pixelIdx + 2];
                        const int ea = layerBytes[pixelIdx + 3];
                        const float dstA = (float)ea * (1.0f / 255.0f);
                        const float dstBlend = dstA * (1.0f - blendA);
                        const float outA = blendA + dstBlend;
                        if (outA <= 0.0f) {
                            layerBytes[pixelIdx + 0] = 0;
                            layerBytes[pixelIdx + 1] = 0;
                            layerBytes[pixelIdx + 2] = 0;
                            layerBytes[pixelIdx + 3] = 0;
                        } else {
                            const float invOutA = 1.0f / outA;
                            int outR = (int)(((float)rByte * blendA + (float)er * dstBlend) * invOutA + 0.5f);
                            int outG = (int)(((float)gByte * blendA + (float)eg * dstBlend) * invOutA + 0.5f);
                            int outB = (int)(((float)bByte * blendA + (float)eb * dstBlend) * invOutA + 0.5f);
                            int outAByte = (int)(outA * 255.0f + 0.5f);
                            if (outR < 0) outR = 0; else if (outR > 255) outR = 255;
                            if (outG < 0) outG = 0; else if (outG > 255) outG = 255;
                            if (outB < 0) outB = 0; else if (outB > 255) outB = 255;
                            if (outAByte < 0) outAByte = 0; else if (outAByte > 255) outAByte = 255;
                            layerBytes[pixelIdx + 0] = (uint8_t)outR;
                            layerBytes[pixelIdx + 1] = (uint8_t)outG;
                            layerBytes[pixelIdx + 2] = (uint8_t)outB;
                            layerBytes[pixelIdx + 3] = (uint8_t)outAByte;
                        }
                    }
                }
            }
            // Scalar tail (0–3 leftover pixels at row's right edge). The
            // outer SIMD loop only built `vDyBase0`, so derive the scalar
            // here.
            const float dyBase0Tail = (float)py - cy;
            for (; px <= p->max_x; px++) {
                const float dxBase0 = (float)px - cx;
                float lx = dxBase0 * cosT + dyBase0Tail * sinT;
                float ly = -dxBase0 * sinT + dyBase0Tail * cosT;
                lx -= shear * ly;
                lx *= fxFlip;
                ly *= fyFlip;
                const float u = lx * invRadius;
                const float v = ly * invRadiusY;
                float dist;
                if (tipKind == 0) dist = sample_sdf_round(u, v) * radius;
                else if (tipKind == 1) dist = sample_sdf_square(u, v) * radius;
                else dist = sample_sdf_diamond(u, v) * radius;
                float coverage;
                if (aaWidth > 0.0f) {
                    float t = (aaWidth - dist) / (2.0f * aaWidth);
                    if (t <= 0.0f) continue;
                    if (t >= 1.0f) coverage = 1.0f;
                    else coverage = t * t * (3.0f - 2.0f * t);
                } else {
                    if (dist > 0.0f) continue;
                    coverage = 1.0f;
                }
                if (coverage <= 0.0f) continue;
                const int cxPx = px;
                const int cyPx = py;
                if (cxPx < 0 || cxPx >= canvasW ||
                    cyPx < 0 || cyPx >= canvasH) continue;
                if (sel_mask && sel_mask[cyPx * canvasW + cxPx] == 0) continue;
                if (grainOn || dualOn) {
                    const float dxBase0 = (float)cxPx - cx;
                    const float dyBase0Lc = (float)cyPx - cy;
                    if (grainOn) {
                        float gx, gy;
                        if (grainFollows) {
                            float lx2 = dxBase0 * cosT + dyBase0Lc * sinT;
                            float ly2 = -dxBase0 * sinT + dyBase0Lc * cosT;
                            lx2 -= shear * ly2;
                            lx2 *= fxFlip;
                            ly2 *= fyFlip;
                            gx = lx2;
                            gy = ly2;
                        } else {
                            gx = (float)cxPx;
                            gy = (float)cyPx;
                        }
                        coverage *= sample_grain(gx, gy, grainAmount, grainScale);
                    }
                    if (dualOn) {
                        coverage *= sample_dual_modulation(
                            dxBase0, dyBase0Lc,
                            dualCosT, dualSinT, dualInvR, dualRadius, dualMix,
                            dualTipKind, dual_sdf_data, dual_sdf_w, dual_sdf_h);
                    }
                    if (coverage <= 0.0f) continue;
                }
                const int lxLocal = cxPx - layerOX;
                const int lyLocal = cyPx - layerOY;
                if (lxLocal < 0 || lxLocal >= layerW ||
                    lyLocal < 0 || lyLocal >= layerH) continue;
                const int touchedKey = cyPx * touchedW + cxPx;
                const uint8_t existingByte = touched_data[touchedKey];
                const float existingA = (float)existingByte * (1.0f / 255.0f);
                const float srcA = srcAlphaScale * coverage;
                if (srcA <= 0.0f) continue;
                float blendA;
                if (hasCap) {
                    const float capA = capAlphaScale * coverage;
                    if (existingA >= capA) continue;
                    const float upgrade = existingA < 1.0f
                        ? (capA - existingA) / (1.0f - existingA)
                        : 0.0f;
                    blendA = srcA < upgrade ? srcA : upgrade;
                    if (blendA <= 0.0f) continue;
                    const float newA = existingA + blendA * (1.0f - existingA);
                    touched_data[touchedKey] = to_byte_nearest(newA);
                } else {
                    if (srcA <= existingA) continue;
                    blendA = existingA < 1.0f
                        ? (srcA - existingA) / (1.0f - existingA)
                        : 0.0f;
                    if (blendA <= 0.0f) continue;
                    touched_data[touchedKey] = to_byte_nearest(srcA);
                }
                const int pixelIdx = (lyLocal * layerW + lxLocal) * 4;
                if (isF32) {
                    const float er = layerF32[pixelIdx + 0];
                    const float eg = layerF32[pixelIdx + 1];
                    const float eb = layerF32[pixelIdx + 2];
                    const float ea = layerF32[pixelIdx + 3];
                    const float dstBlend = ea * (1.0f - blendA);
                    const float outA = blendA + dstBlend;
                    if (outA <= 0.0f) {
                        layerF32[pixelIdx + 0] = 0.0f;
                        layerF32[pixelIdx + 1] = 0.0f;
                        layerF32[pixelIdx + 2] = 0.0f;
                        layerF32[pixelIdx + 3] = 0.0f;
                    } else {
                        const float invOutA = 1.0f / outA;
                        layerF32[pixelIdx + 0] = (fr * blendA + er * dstBlend) * invOutA;
                        layerF32[pixelIdx + 1] = (fg * blendA + eg * dstBlend) * invOutA;
                        layerF32[pixelIdx + 2] = (fb * blendA + eb * dstBlend) * invOutA;
                        layerF32[pixelIdx + 3] = outA;
                    }
                } else {
                    const int er = layerBytes[pixelIdx + 0];
                    const int eg = layerBytes[pixelIdx + 1];
                    const int eb = layerBytes[pixelIdx + 2];
                    const int ea = layerBytes[pixelIdx + 3];
                    const float dstA = (float)ea * (1.0f / 255.0f);
                    const float dstBlend = dstA * (1.0f - blendA);
                    const float outA = blendA + dstBlend;
                    if (outA <= 0.0f) {
                        layerBytes[pixelIdx + 0] = 0;
                        layerBytes[pixelIdx + 1] = 0;
                        layerBytes[pixelIdx + 2] = 0;
                        layerBytes[pixelIdx + 3] = 0;
                    } else {
                        const float invOutA = 1.0f / outA;
                        int outR = (int)(((float)rByte * blendA + (float)er * dstBlend) * invOutA + 0.5f);
                        int outG = (int)(((float)gByte * blendA + (float)eg * dstBlend) * invOutA + 0.5f);
                        int outB = (int)(((float)bByte * blendA + (float)eb * dstBlend) * invOutA + 0.5f);
                        int outAByte = (int)(outA * 255.0f + 0.5f);
                        if (outR < 0) outR = 0; else if (outR > 255) outR = 255;
                        if (outG < 0) outG = 0; else if (outG > 255) outG = 255;
                        if (outB < 0) outB = 0; else if (outB > 255) outB = 255;
                        if (outAByte < 0) outAByte = 0; else if (outAByte > 255) outAByte = 255;
                        layerBytes[pixelIdx + 0] = (uint8_t)outR;
                        layerBytes[pixelIdx + 1] = (uint8_t)outG;
                        layerBytes[pixelIdx + 2] = (uint8_t)outB;
                        layerBytes[pixelIdx + 3] = (uint8_t)outAByte;
                    }
                }
            }
        }
        return;
    }
#endif

    // ── Scalar fallback ─────────────────────────────────────────────────
    // Used when SIMD isn't compiled in OR when the stamp config uses a
    // feature the SIMD path doesn't support (bitmap tip, smudge, tiled).
    for (int py = p->min_y; py <= p->max_y; py++) {
        const float dyBase0 = (float)py - cy;
        for (int px = p->min_x; px <= p->max_x; px++) {
            const float dxBase0 = (float)px - cx;

            // Inverse rotation into tip-local axes.
            float lx = dxBase0 * cosT + dyBase0 * sinT;
            float ly = -dxBase0 * sinT + dyBase0 * cosT;
            // Tilt-driven shear in tip-local x along y.
            lx -= shear * ly;
            // Flip in tip-local space.
            lx *= fxFlip;
            ly *= fyFlip;
            const float u = lx * invRadius;
            const float v = ly * invRadiusY;

            float dist;
            switch (tipKind) {
                case 0: dist = sample_sdf_round(u, v) * radius; break;
                case 1: dist = sample_sdf_square(u, v) * radius; break;
                case 2: dist = sample_sdf_diamond(u, v) * radius; break;
                case 3: dist = sample_sdf_bitmap(sdf_data, sdf_w, sdf_h, u, v) * radius; break;
                default: continue;
            }

            float coverage;
            if (aaWidth > 0.0f) {
                float t = (aaWidth - dist) / (2.0f * aaWidth);
                if (t <= 0.0f) continue;
                if (t >= 1.0f) coverage = 1.0f;
                else coverage = t * t * (3.0f - 2.0f * t);
            } else {
                if (dist > 0.0f) continue;
                coverage = 1.0f;
            }
            if (coverage <= 0.0f) continue;

            // Paper grain — `lx`/`ly` are already in tip-local coords (post
            // shear + flip); use those for followBrush, raw canvas px/py
            // otherwise.
            if (grainOn) {
                const float gx = grainFollows ? lx : (float)px;
                const float gy = grainFollows ? ly : (float)py;
                coverage *= sample_grain(gx, gy, grainAmount, grainScale);
                if (coverage <= 0.0f) continue;
            }
            // Dual brush — second-tip alpha multiplied per pixel.
            if (dualOn) {
                coverage *= sample_dual_modulation(
                    dxBase0, dyBase0,
                    dualCosT, dualSinT, dualInvR, dualRadius, dualMix,
                    dualTipKind, dual_sdf_data, dual_sdf_w, dual_sdf_h);
                if (coverage <= 0.0f) continue;
            }

            // Wrap to canvas coords (tiled) BEFORE the touched-map key so a
            // pixel at (-1, 0) and (W-1, 0) share the same map entry.
            int cxPx = px;
            int cyPx = py;
            if (tiled) {
                cxPx = mod_pos(cxPx, tiledW);
                cyPx = mod_pos(cyPx, tiledH);
            }
            if (cxPx < 0 || cxPx >= canvasW || cyPx < 0 || cyPx >= canvasH)
                continue;
            if (sel_mask && sel_mask[cyPx * canvasW + cxPx] == 0) continue;

            const int lxLocal = cxPx - layerOX;
            const int lyLocal = cyPx - layerOY;
            if (lxLocal < 0 || lxLocal >= layerW ||
                lyLocal < 0 || lyLocal >= layerH) continue;

            const int touchedKey = cyPx * touchedW + cxPx;
            const uint8_t existingByte = touched_data[touchedKey];
            const float existingA = (float)existingByte * (1.0f / 255.0f);

            // ── Per-pixel srcA / capA / blendA ───────────────────────────
            const float srcA = srcAlphaScale * coverage;
            if (srcA <= 0.0f) continue;

            float blendA = srcA;
            if (bypassCap) {
                // Smudge / build-up — not currently routed through here, but
                // implement for completeness (matches blendPixelOver branch).
                const float geom = bypassGeomScale * coverage;
                const uint8_t geomByte = to_byte_nearest(geom);
                if (geomByte > existingByte) touched_data[touchedKey] = geomByte;
            } else if (hasCap) {
                const float capA = capAlphaScale * coverage;
                if (existingA >= capA) continue;
                const float upgrade = existingA < 1.0f
                    ? (capA - existingA) / (1.0f - existingA)
                    : 0.0f;
                blendA = srcA < upgrade ? srcA : upgrade;
                if (blendA <= 0.0f) continue;
                const float newA = existingA + blendA * (1.0f - existingA);
                touched_data[touchedKey] = to_byte_nearest(newA);
            } else {
                if (srcA <= existingA) continue;
                blendA = existingA < 1.0f
                    ? (srcA - existingA) / (1.0f - existingA)
                    : 0.0f;
                if (blendA <= 0.0f) continue;
                touched_data[touchedKey] = to_byte_nearest(srcA);
            }

            // ── Porter-Duff "over" composite ─────────────────────────────
            const int pixelIdx = (lyLocal * layerW + lxLocal) * 4;
            if (isF32) {
                const float er = layerF32[pixelIdx + 0];
                const float eg = layerF32[pixelIdx + 1];
                const float eb = layerF32[pixelIdx + 2];
                const float ea = layerF32[pixelIdx + 3];
                const float dstBlend = ea * (1.0f - blendA);
                const float outA = blendA + dstBlend;
                if (outA <= 0.0f) {
                    layerF32[pixelIdx + 0] = 0.0f;
                    layerF32[pixelIdx + 1] = 0.0f;
                    layerF32[pixelIdx + 2] = 0.0f;
                    layerF32[pixelIdx + 3] = 0.0f;
                } else {
                    const float invOutA = 1.0f / outA;
                    layerF32[pixelIdx + 0] = (fr * blendA + er * dstBlend) * invOutA;
                    layerF32[pixelIdx + 1] = (fg * blendA + eg * dstBlend) * invOutA;
                    layerF32[pixelIdx + 2] = (fb * blendA + eb * dstBlend) * invOutA;
                    layerF32[pixelIdx + 3] = outA;
                }
            } else {
                const int er = layerBytes[pixelIdx + 0];
                const int eg = layerBytes[pixelIdx + 1];
                const int eb = layerBytes[pixelIdx + 2];
                const int ea = layerBytes[pixelIdx + 3];
                const float dstA = (float)ea * (1.0f / 255.0f);
                const float dstBlend = dstA * (1.0f - blendA);
                const float outA = blendA + dstBlend;
                if (outA <= 0.0f) {
                    layerBytes[pixelIdx + 0] = 0;
                    layerBytes[pixelIdx + 1] = 0;
                    layerBytes[pixelIdx + 2] = 0;
                    layerBytes[pixelIdx + 3] = 0;
                } else {
                    const float invOutA = 1.0f / outA;
                    int outR = (int)(((float)rByte * blendA + (float)er * dstBlend) * invOutA + 0.5f);
                    int outG = (int)(((float)gByte * blendA + (float)eg * dstBlend) * invOutA + 0.5f);
                    int outB = (int)(((float)bByte * blendA + (float)eb * dstBlend) * invOutA + 0.5f);
                    int outAByte = (int)(outA * 255.0f + 0.5f);
                    if (outR < 0) outR = 0; else if (outR > 255) outR = 255;
                    if (outG < 0) outG = 0; else if (outG > 255) outG = 255;
                    if (outB < 0) outB = 0; else if (outB > 255) outB = 255;
                    if (outAByte < 0) outAByte = 0; else if (outAByte > 255) outAByte = 255;
                    layerBytes[pixelIdx + 0] = (uint8_t)outR;
                    layerBytes[pixelIdx + 1] = (uint8_t)outG;
                    layerBytes[pixelIdx + 2] = (uint8_t)outB;
                    layerBytes[pixelIdx + 3] = (uint8_t)outAByte;
                }
            }
        }
    }
}
