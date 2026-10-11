// brush_stamp.cpp
//
// Implementation notes:
//   * Every path shares one set of inline helpers — tip coverage, dual /
//     grain modulation, cap/flow accumulation and compositing — so the
//     SIMD, scalar, bitmap and bake paths can't drift apart. The SIMD paths
//     only vectorise the procedural tip coverage and the rgba8 composite.
//   * Pixel centres sit at integer canvas coordinates: a stamp at
//     (10.0, 10.0) is centred on pixel (10, 10). The JS side converts
//     pointer positions accordingly.
//   * sRGB→linear conversion for rgba32f writes is done JS-side: the caller
//     passes already-linear `fr/fg/fb`.
//   * 8-bit writes use stochastic rounding (`floor(x + u)`, u a per-pixel
//     hash in [0, 1)) instead of round-to-nearest. Nearest rounding drops
//     any change smaller than half a level, which stalled low-flow glazes
//     tens of levels short of the target colour and let the coverage buffer
//     under-count (so low flow could exceed its opacity ceiling). Exact
//     values are unaffected.

#include "brush_stamp.h"
#include <cmath>
#include <cstddef>

#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

namespace {

#define BS_INLINE __attribute__((always_inline)) inline

// ── Tip coverage ──────────────────────────────────────────────────────

struct TipTex {
    const float* data;
    int w;
    int h;
};

// Bilinear density lookup of a bitmap tip level; outside the map is empty.
// Mirrors `sampleTipLevel` in tipSampler.ts.
inline float sample_tip(const TipTex& t, float u, float v) {
    if (t.data == nullptr || t.w <= 0 || t.h <= 0) return 0.0f;
    const float halfMax = (float)(t.w > t.h ? t.w : t.h) * 0.5f;
    const float px = u * halfMax + (float)t.w * 0.5f - 0.5f;
    const float py = v * halfMax + (float)t.h * 0.5f - 0.5f;
    const float x0f = std::floor(px);
    const float y0f = std::floor(py);
    if (x0f < -1.0f || y0f < -1.0f || x0f >= (float)t.w || y0f >= (float)t.h) return 0.0f;
    const int x0 = (int)x0f, y0 = (int)y0f;
    const int x1 = x0 + 1, y1 = y0 + 1;
    const float fx = px - x0f, fy = py - y0f;
    const bool inX0 = x0 >= 0, inX1 = x1 < t.w, inY0 = y0 >= 0, inY1 = y1 < t.h;
    const float s00 = (inX0 && inY0) ? t.data[static_cast<ptrdiff_t>(y0) * t.w + x0] : 0.0f;
    const float s10 = (inX1 && inY0) ? t.data[static_cast<ptrdiff_t>(y0) * t.w + x1] : 0.0f;
    const float s01 = (inX0 && inY1) ? t.data[static_cast<ptrdiff_t>(y1) * t.w + x0] : 0.0f;
    const float s11 = (inX1 && inY1) ? t.data[static_cast<ptrdiff_t>(y1) * t.w + x1] : 0.0f;
    return (s00 * (1.0f - fx) + s10 * fx) * (1.0f - fy) + (s01 * (1.0f - fx) + s11 * fx) * fy;
}

// Procedural tip coverage at tip-local unit coords. Mirrors
// `proceduralCoverage` in tipSampler.ts: soft core × 1 px AA edge, the edge
// measured in true pixels (unit SDF ÷ its pixel-space gradient).
// `constGrad` > 0 short-cuts the gradient when it is the same everywhere
// (round / square at roundness 1, diamond always) — same value, no sqrt.
BS_INLINE float procedural_coverage(
    int kind, float u, float v, float invR, float invRY, float softness, bool aa,
    float constGrad = 0.0f
) {
    float sdf, grad;
    if (kind == 0) {
        const float len = std::sqrt(u * u + v * v);
        sdf = len - 1.0f;
        if (constGrad > 0.0f) {
            grad = constGrad;
        } else {
            const float l = len > 1e-6f ? len : 1e-6f;
            grad = std::sqrt(u * u * invR * invR + v * v * invRY * invRY) / l;
        }
    } else if (kind == 1) {
        const float au = std::fabs(u), av = std::fabs(v);
        if (au > av) { sdf = au - 1.0f; grad = invR; }
        else         { sdf = av - 1.0f; grad = invRY; }
    } else {
        sdf = std::fabs(u) + std::fabs(v) - 1.0f;
        grad = std::sqrt(invR * invR + invRY * invRY);
    }
    float edge;
    if (aa) {
        const float distPx = sdf / (grad > 1e-12f ? grad : 1e-12f);
        edge = 0.5f - distPx;
        if (edge <= 0.0f) return 0.0f;
        if (edge > 1.0f) edge = 1.0f;
    } else {
        if (sdf > 0.0f) return 0.0f;
        edge = 1.0f;
    }
    if (softness <= 0.0f) return edge;
    float x = -sdf / softness;
    if (x <= 0.0f) return 0.0f;
    if (x >= 1.0f) return edge;
    return edge * x * x * (3.0f - 2.0f * x);
}

// Round tip swept from the segment start (su, sv) — tip-local unit coords,
// radius k0 there — to the centre (radius 1): distance to the segment
// instead of to the centre. Only pixels level with or ahead of the start
// are painted. Mirrors `sweptRoundCoverage` in tipSampler.ts.
BS_INLINE float swept_round_coverage(
    float u, float v, float su, float sv, float invLen2, float k0,
    float invR, float invRY, float softness, bool aa, float constGrad
) {
    float t = -((u - su) * su + (v - sv) * sv) * invLen2;
    // Behind the segment start: the previous dab painted this pixel with
    // the same coverage (its end), so there is nothing to add.
    if (t < 0.0f) return 0.0f;
    if (t > 1.0f) t = 1.0f;
    const float w = 1.0f - t;
    const float cu = u - su * w;
    const float cv = v - sv * w;
    const float len = std::sqrt(cu * cu + cv * cv);
    const float k = k0 + (1.0f - k0) * t;
    const float sdf = len - k;
    float grad;
    if (constGrad > 0.0f) {
        grad = constGrad;
    } else {
        const float l = len > 1e-6f ? len : 1e-6f;
        grad = std::sqrt(cu * cu * invR * invR + cv * cv * invRY * invRY) / l;
    }
    float edge;
    if (aa) {
        edge = 0.5f - sdf / (grad > 1e-12f ? grad : 1e-12f);
        if (edge <= 0.0f) return 0.0f;
        if (edge > 1.0f) edge = 1.0f;
    } else {
        if (sdf > 0.0f) return 0.0f;
        edge = 1.0f;
    }
    if (softness <= 0.0f) return edge;
    const float x = -sdf / (k * softness);
    if (x <= 0.0f) return 0.0f;
    if (x >= 1.0f) return edge;
    return edge * x * x * (3.0f - 2.0f * x);
}

// Dual tip: hard, isotropic, 1 px AA silhouette (or bitmap density).
// Mirrors `dualProceduralCoverage` in tipSampler.ts.
inline float dual_coverage(int kind, float u, float v, float dualRadius, const TipTex& tex) {
    if (kind == 3) return sample_tip(tex, u, v);
    float sdf, grad = 1.0f;
    if (kind == 0) sdf = std::sqrt(u * u + v * v) - 1.0f;
    else if (kind == 1) {
        const float au = std::fabs(u), av = std::fabs(v);
        sdf = (au > av ? au : av) - 1.0f;
    } else {
        sdf = std::fabs(u) + std::fabs(v) - 1.0f;
        grad = 1.41421356f;
    }
    const float distPx = sdf * dualRadius / grad;
    if (distPx >= 0.5f) return 0.0f;
    if (distPx <= -0.5f) return 1.0f;
    return 0.5f - distPx;
}

// ── Paper grain (mirrors paperTexture.ts) ─────────────────────────────

inline float hash2(int ix, int iy, uint32_t salt) {
    uint32_t h = ((uint32_t)ix * 0x27d4eb2du) ^ ((uint32_t)iy * 0x165667b1u) ^ (salt * 0x9e3779b1u);
    h ^= h >> 15;
    h *= 0x2c1b3c6du;
    h ^= h >> 12;
    h *= 0x297a2d39u;
    h ^= h >> 15;
    return (float)h * (1.0f / 4294967296.0f);
}

inline float value_noise(float x, float y, float period, uint32_t salt) {
    const float u = x / period;
    const float v = y / period;
    const float ixF = std::floor(u);
    const float iyF = std::floor(v);
    float fx = u - ixF;
    float fy = v - iyF;
    fx = fx * fx * (3.0f - 2.0f * fx);
    fy = fy * fy * (3.0f - 2.0f * fy);
    const int ix = (int)ixF;
    const int iy = (int)iyF;
    const float a = hash2(ix, iy, salt) * (1.0f - fx) + hash2(ix + 1, iy, salt) * fx;
    const float b = hash2(ix, iy + 1, salt) * (1.0f - fx) + hash2(ix + 1, iy + 1, salt) * fx;
    return a * (1.0f - fy) + b * fy;
}

inline float grain_noise(float x, float y, float scale) {
    const float p = scale < 2.0f ? 2.0f : scale;
    const float p2 = p / 2.13f < 1.5f ? 1.5f : p / 2.13f;
    const float p3 = p / 4.37f < 1.25f ? 1.25f : p / 4.37f;
    const float f =
        0.5f * value_noise(x, y, p, 1u) +
        0.3f * value_noise(x, y, p2, 2u) +
        0.2f * value_noise(x, y, p3, 3u);
    const float n = (f - 0.5f) * 1.8f + 0.5f;
    return n < 0.0f ? 0.0f : (n > 1.0f ? 1.0f : n);
}

// ── Stochastic rounding ───────────────────────────────────────────────

// Per-pixel uniform in [0, 1), decorrelated per stamp by `seed`.
BS_INLINE float dither_u(int x, int y, uint32_t seed) {
    uint32_t h = ((uint32_t)x * 0x8da6b343u) ^ ((uint32_t)y * 0xd8163841u) ^ (seed * 0xcb1ab31fu);
    h ^= h >> 16;
    h *= 0x7feb352du;
    h ^= h >> 15;
    h *= 0x846ca68bu;
    h ^= h >> 16;
    return (float)(h >> 8) * (1.0f / 16777216.0f);
}

// Scale `u` into [1e-4, 1 − 1e-4) so a value that is an exact level up to
// float error (254.99998) still lands on that level.
BS_INLINE float dither_bias(float u) { return 0.0001f + u * 0.9998f; }

// floor(x × 255 + bias), clamped — `x` in [0, 1].
BS_INLINE uint8_t to_byte_dither(float x, float bias) {
    if (x <= 0.0f) return 0;
    if (x >= 1.0f) return 255;
    const int v = (int)(x * 255.0f + bias);
    return (uint8_t)(v > 255 ? 255 : v);
}

// Smallest level ≥ x (with a little float slack), clamped.
BS_INLINE uint8_t to_byte_ceil(float x) {
    if (x <= 0.0f) return 0;
    if (x >= 1.0f) return 255;
    const int v = (int)std::ceil(x * 255.0f - 0.001f);
    return (uint8_t)(v > 255 ? 255 : (v < 0 ? 0 : v));
}

BS_INLINE uint8_t to_byte_nearest(float x) {
    if (x <= 0.0f) return 0;
    if (x >= 1.0f) return 255;
    return (uint8_t)(x * 255.0f + 0.5f);
}

BS_INLINE int clamp255(int v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

// ── Per-stamp context ─────────────────────────────────────────────────

struct Stamp {
    // Geometry
    float cx, cy, radius, invR, invRY, cosT, sinT, shear, fxFlip, fyFlip, softness;
    // The tip SDF's pixel-space gradient when constant over the tip, else 0,
    // and the reciprocals the SIMD path multiplies by.
    float constGrad, invConstGrad, radiusY, invSoftness;
    bool aa;
    int tipKind;
    TipTex tip;
    // Swept dab: segment start in tip-local unit coords, 1 / its squared
    // length, and the radius there (fraction of `radius`).
    bool sweep;
    float su, sv, sInvLen2, sK0;
    // Dual
    bool dualOn;
    float dualR, dualInvR, dualCos, dualSin, dualMix;
    int dualKind;
    TipTex dualTip;
    // Grain
    bool grainOn, grainFollows, grainSubtract;
    float grainAmount, grainScale, invAlpha;
    // Blend
    float srcAlphaScale, capAlphaScale, bypassGeomScale;
    bool hasCap, bypassCap;
    // srcAlphaScale >= 1: a fully covered pixel blends at alpha 1 and lands
    // on the exact colour, so it needs no dither.
    bool fullAlpha;
    int maxTouchedByte;  // > 255 = never skip on the coverage buffer
    bool isF32;
    uint8_t* layerBytes;
    float* layerF32;
    int layerOX, layerOY, layerW, layerH;
    uint8_t* touched;
    int touchedW, canvasW, canvasH;
    const uint8_t* sel;
    float r8, g8, b8;  // 0..255
    float fr, fg, fb;  // linear (rgba32f)
    uint32_t seed;
    bool tiled;
    int tiledW, tiledH;
};

BS_INLINE void init_stamp(
    Stamp& s, const BrushStampParams* p, void* layer_data, uint8_t* touched,
    const uint8_t* sel, TipTex tip, TipTex dualTip
) {
    s.cx = p->cx;
    s.cy = p->cy;
    s.radius = p->radius;
    s.invR = s.radius > 0.0f ? 1.0f / s.radius : 0.0f;
    const float rn = p->roundness > 0.0f ? p->roundness : 1.0f;
    s.invRY = s.radius > 0.0f ? 1.0f / (s.radius * rn) : 0.0f;
    s.cosT = std::cos(p->angle);
    s.sinT = std::sin(p->angle);
    s.shear = p->shear;
    s.fxFlip = (float)p->flip_x;
    s.fyFlip = (float)p->flip_y;
    s.softness = p->softness < 0.0f ? 0.0f : (p->softness > 1.0f ? 1.0f : p->softness);
    if (p->tip_kind == 2) s.constGrad = std::sqrt(s.invR * s.invR + s.invRY * s.invRY);
    else if (s.invR == s.invRY) s.constGrad = s.invR;
    else s.constGrad = 0.0f;
    s.invConstGrad = s.constGrad > 0.0f ? 1.0f / s.constGrad : 0.0f;
    s.radiusY = s.invRY > 0.0f ? 1.0f / s.invRY : 0.0f;
    s.invSoftness = s.softness > 0.0f ? 1.0f / s.softness : 0.0f;
    s.aa = p->aa > 0.0f;
    s.tipKind = p->tip_kind;
    s.tip = tip;

    s.sweep = false;
    s.su = s.sv = s.sInvLen2 = 0.0f;
    s.sK0 = 1.0f;
    if (s.tipKind == 0 && (p->sweep_dx != 0.0f || p->sweep_dy != 0.0f)) {
        float lx = p->sweep_dx * s.cosT + p->sweep_dy * s.sinT;
        float ly = -p->sweep_dx * s.sinT + p->sweep_dy * s.cosT;
        lx -= s.shear * ly;
        const float su = lx * s.fxFlip * s.invR;
        const float sv = ly * s.fyFlip * s.invRY;
        const float len2 = su * su + sv * sv;
        if (len2 > 1e-8f) {
            s.sweep = true;
            s.su = su;
            s.sv = sv;
            s.sInvLen2 = 1.0f / len2;
            s.sK0 = p->sweep_r0 > 0.0f ? p->sweep_r0 : 1.0f;
        }
    }

    s.dualR = p->dual_active ? s.radius * p->dual_size_ratio : 0.0f;
    s.dualOn = p->dual_active != 0 && s.dualR >= 0.5f && p->dual_mix > 0.0f;
    s.dualInvR = s.dualOn ? 1.0f / s.dualR : 0.0f;
    s.dualCos = s.dualOn ? std::cos(p->dual_base_angle) : 1.0f;
    s.dualSin = s.dualOn ? std::sin(p->dual_base_angle) : 0.0f;
    s.dualMix = s.dualOn ? (p->dual_mix > 1.0f ? 1.0f : p->dual_mix) : 0.0f;
    s.dualKind = p->dual_tip_kind;
    s.dualTip = dualTip;

    s.isF32 = p->layer_format == 1;
    s.layerBytes = s.isF32 ? nullptr : (uint8_t*)layer_data;
    s.layerF32 = s.isF32 ? (float*)layer_data : nullptr;
    s.layerOX = p->layer_offset_x;
    s.layerOY = p->layer_offset_y;
    s.layerW = p->layer_w;
    s.layerH = p->layer_h;
    s.touched = touched;
    s.touchedW = p->touched_w;
    s.canvasW = p->touched_w;
    s.canvasH = p->touched_h;
    s.sel = sel;

    s.r8 = (float)p->r;
    s.g8 = (float)p->g;
    s.b8 = (float)p->b;
    s.fr = p->fr;
    s.fg = p->fg;
    s.fb = p->fb;
    s.seed = (uint32_t)p->dither_seed;

    const float aFraction = (float)p->a * (1.0f / 255.0f);
    const float alpha = s.isF32 ? p->fa : aFraction;
    s.hasCap = p->cap_opacity >= 0.0f;
    s.bypassCap = p->bypass_cap != 0;
    s.srcAlphaScale = alpha * (p->opacity * 0.01f);
    s.capAlphaScale = s.hasCap ? alpha * (p->cap_opacity * 0.01f) : 0.0f;
    s.bypassGeomScale = p->opacity * 0.01f;
    s.fullAlpha = s.srcAlphaScale >= 1.0f;

    s.grainAmount = p->grain_amount;
    s.grainOn = s.grainAmount > 0.0f;
    s.grainScale = p->grain_scale < 2.0f ? 2.0f : p->grain_scale;
    s.grainFollows = p->grain_follow_brush != 0;
    s.grainSubtract = p->grain_mode == 1;
    // Sweeping replaces the max-of-dabs coverage of a full-flow stroke with
    // the continuous one. Accumulating strokes (flow, bypass) deposit per
    // dab: sweeping them would add the segment end caps at discrete spots.
    if (s.hasCap || s.bypassCap) s.sweep = false;
    const float alphaRef = s.hasCap ? s.capAlphaScale : s.srcAlphaScale;
    s.invAlpha = 1.0f / (alphaRef > 1e-3f ? alphaRef : 1e-3f);

    s.tiled = p->tiled != 0;
    s.tiledW = p->tiled_w;
    s.tiledH = p->tiled_h;

    // Saturation threshold: the coverage byte any part of this stamp could
    // raise a pixel to (coverage = 1). At or past it the pixel can't change.
    // The bypass-cap path has no ceiling.
    s.maxTouchedByte = 256;
    if (!s.bypassCap) {
        const float relevantOpacity = s.hasCap ? p->cap_opacity : p->opacity;
        const int t = (int)((float)p->a * relevantOpacity * 0.01f);
        s.maxTouchedByte = t < 256 ? t : 256;
    }
}

// Canvas offset → tip-local pixel coords (rotation, shear, flip).
BS_INLINE void to_tip_local(const Stamp& s, float dx, float dy, float& lx, float& ly) {
    lx = dx * s.cosT + dy * s.sinT;
    ly = -dx * s.sinT + dy * s.cosT;
    lx -= s.shear * ly;
    lx *= s.fxFlip;
    ly *= s.fyFlip;
}

BS_INLINE float shape_coverage(const Stamp& s, float lx, float ly) {
    const float u = lx * s.invR;
    const float v = ly * s.invRY;
    if (s.tipKind == 3) return sample_tip(s.tip, u, v);
    if (s.sweep) {
        return swept_round_coverage(u, v, s.su, s.sv, s.sInvLen2, s.sK0,
                                    s.invR, s.invRY, s.softness, s.aa, s.constGrad);
    }
    return procedural_coverage(s.tipKind, u, v, s.invR, s.invRY, s.softness, s.aa, s.constGrad);
}

inline float dual_modulation(const Stamp& s, float dx, float dy) {
    const float dlx = dx * s.dualCos + dy * s.dualSin;
    const float dly = -dx * s.dualSin + dy * s.dualCos;
    const float d = dual_coverage(s.dualKind, dlx * s.dualInvR, dly * s.dualInvR, s.dualR, s.dualTip);
    return 1.0f - s.dualMix + s.dualMix * d;
}

inline float apply_grain(const Stamp& s, float coverage, float gx, float gy) {
    const float tooth = s.grainAmount * (1.0f - grain_noise(gx, gy, s.grainScale));
    if (!s.grainSubtract) return coverage * (1.0f - tooth);
    const float c = coverage - tooth * s.invAlpha;
    return c > 0.0f ? c : 0.0f;
}

// Dual + grain modulation of the tip coverage at canvas pixel (px, py).
BS_INLINE float modulate(const Stamp& s, float coverage, int px, int py, bool withDual, bool withGrain) {
    const float dx = (float)px - s.cx;
    const float dy = (float)py - s.cy;
    if (withDual && s.dualOn) {
        coverage *= dual_modulation(s, dx, dy);
        if (coverage <= 0.0f) return 0.0f;
    }
    if (withGrain && s.grainOn) {
        if (s.grainFollows) {
            float lx, ly;
            to_tip_local(s, dx, dy, lx, ly);
            coverage = apply_grain(s, coverage, lx, ly);
        } else {
            coverage = apply_grain(s, coverage, (float)px, (float)py);
        }
    }
    return coverage;
}

// Update the coverage buffer for one pixel and return the alpha to blend
// (0 = nothing to do). `coverage` includes the selection, `selF` is the
// selection alone. Opacity / Flow semantics as in `blendPixelOver`:
//   * bypass: no ceiling; the buffer still grows (silhouette for wet edges)
//   * cap:    each stamp deposits its flow share, building up toward the
//             Opacity ceiling — flat, like Photoshop ("builds up to the
//             opacity setting"): a ceiling shaped by each dab's coverage
//             clipped the build-up per dab position and rippled the stroke
//   * plain:  the stamp's alpha is the ceiling; only upgrades paint
BS_INLINE float accumulate(const Stamp& s, ptrdiff_t key, float coverage, float selF, float bias) {
    const uint8_t existingByte = s.touched[key];
    const float existingA = (float)existingByte * (1.0f / 255.0f);
    const float srcA = s.srcAlphaScale * coverage;
    if (srcA <= 0.0f) return 0.0f;
    if (s.bypassCap) {
        const uint8_t geomByte = to_byte_nearest(s.bypassGeomScale * coverage);
        if (geomByte > existingByte) s.touched[key] = geomByte;
        return srcA;
    }
    if (s.hasCap) {
        const float capA = s.capAlphaScale * selF;
        if (existingA >= capA) return 0.0f;
        const float upgrade = existingA < 1.0f ? (capA - existingA) / (1.0f - existingA) : 0.0f;
        const float blendA = srcA < upgrade ? srcA : upgrade;
        if (blendA <= 0.0f) return 0.0f;
        // Below the ceiling the buffer rounds stochastically (sub-level
        // deposits count on average). At the ceiling it rounds up: a
        // rounded-down ceiling left a sliver every later stamp re-blended,
        // so overlapping stamps crept past the opacity.
        s.touched[key] = srcA >= upgrade
            ? to_byte_ceil(capA)
            : to_byte_dither(existingA + blendA * (1.0f - existingA), bias);
        return blendA;
    }
    if (srcA <= existingA) return 0.0f;
    const float blendA = existingA < 1.0f ? (srcA - existingA) / (1.0f - existingA) : 0.0f;
    if (blendA <= 0.0f) return 0.0f;
    s.touched[key] = to_byte_ceil(srcA);  // see above: no re-blended slivers
    return blendA;
}

// Porter-Duff "over" of the stamp colour at layer-local (lx, ly).
BS_INLINE void composite(const Stamp& s, int lx, int ly, float blendA, float bias) {
    const ptrdiff_t idx = (static_cast<ptrdiff_t>(ly) * s.layerW + lx) * 4;
    if (s.isF32) {
        float* d = s.layerF32 + idx;
        const float dstBlend = d[3] * (1.0f - blendA);
        const float outA = blendA + dstBlend;
        if (outA <= 0.0f) {
            d[0] = d[1] = d[2] = d[3] = 0.0f;
            return;
        }
        const float inv = 1.0f / outA;
        d[0] = (s.fr * blendA + d[0] * dstBlend) * inv;
        d[1] = (s.fg * blendA + d[1] * dstBlend) * inv;
        d[2] = (s.fb * blendA + d[2] * dstBlend) * inv;
        d[3] = outA;
        return;
    }
    uint8_t* d = s.layerBytes + idx;
    const float dstA = (float)d[3] * (1.0f / 255.0f);
    const float dstBlend = dstA * (1.0f - blendA);
    const float outA = blendA + dstBlend;
    if (outA <= 0.0f) {
        d[0] = d[1] = d[2] = d[3] = 0;
        return;
    }
    const float inv = 1.0f / outA;
    d[0] = (uint8_t)clamp255((int)((s.r8 * blendA + (float)d[0] * dstBlend) * inv + bias));
    d[1] = (uint8_t)clamp255((int)((s.g8 * blendA + (float)d[1] * dstBlend) * inv + bias));
    d[2] = (uint8_t)clamp255((int)((s.b8 * blendA + (float)d[2] * dstBlend) * inv + bias));
    d[3] = (uint8_t)clamp255((int)(outA * 255.0f + bias));
}

// Paint `coverage` (tip × dual × grain, before selection) at canvas pixel
// (px, py): wrap, clip, selection, accumulate, composite.
BS_INLINE void blend_pixel(const Stamp& s, int px, int py, float coverage) {
    if (s.tiled) {
        px %= s.tiledW; if (px < 0) px += s.tiledW;
        py %= s.tiledH; if (py < 0) py += s.tiledH;
    }
    if (px < 0 || px >= s.canvasW || py < 0 || py >= s.canvasH) return;
    const ptrdiff_t key = static_cast<ptrdiff_t>(py) * s.touchedW + px;
    if ((int)s.touched[key] >= s.maxTouchedByte) return;
    float selF = 1.0f;
    if (s.sel) {
        const uint8_t v = s.sel[static_cast<ptrdiff_t>(py) * s.canvasW + px];
        if (v == 0) return;
        if (v != 255) {
            selF = (float)v * (1.0f / 255.0f);
            coverage *= selF;
        }
    }
    const int lx = px - s.layerOX;
    const int ly = py - s.layerOY;
    if (lx < 0 || lx >= s.layerW || ly < 0 || ly >= s.layerH) return;
    const float bias = (s.fullAlpha && coverage >= 1.0f)
        ? 0.5f : dither_bias(dither_u(px, py, s.seed));
    const float blendA = accumulate(s, key, coverage, selF, bias);
    if (blendA > 0.0f) composite(s, lx, ly, blendA, bias);
}

// True when all four coverage bytes at `t` are saturated for this stamp.
BS_INLINE bool group_saturated(const Stamp& s, const uint8_t* t) {
    return s.maxTouchedByte <= 255 &&
        (int)t[0] >= s.maxTouchedByte && (int)t[1] >= s.maxTouchedByte &&
        (int)t[2] >= s.maxTouchedByte && (int)t[3] >= s.maxTouchedByte;
}

#ifdef __wasm_simd128__
// Blend four horizontally adjacent rgba8 pixels starting at canvas (px, py)
// with per-lane coverage. Caller guarantees: rgba8, no selection, all four
// lanes inside the canvas and the layer, not tiled. Returns after writing.
BS_INLINE void blend_group_rgba8(
    const Stamp& s, int px, int py, const float* laneCov
) {
    alignas(16) uint32_t laneMask[4] = {0, 0, 0, 0};
    alignas(16) float laneBlendA[4] = {0, 0, 0, 0};
    alignas(16) float laneBias[4] = {0, 0, 0, 0};
    const ptrdiff_t rowKey = static_cast<ptrdiff_t>(py) * s.touchedW;
    bool any = false;
    for (int lane = 0; lane < 4; lane++) {
        if (laneCov[lane] <= 0.0f) continue;
        const ptrdiff_t key = rowKey + px + lane;
        if ((int)s.touched[key] >= s.maxTouchedByte) continue;
        const float bias = (s.fullAlpha && laneCov[lane] >= 1.0f)
            ? 0.5f : dither_bias(dither_u(px + lane, py, s.seed));
        const float blendA = accumulate(s, key, laneCov[lane], 1.0f, bias);
        if (blendA <= 0.0f) continue;
        laneMask[lane] = 0xFFFFFFFFu;
        laneBlendA[lane] = blendA;
        laneBias[lane] = bias;
        any = true;
    }
    if (!any) return;

    const v128_t vOne = wasm_f32x4_splat(1.0f);
    const v128_t vZero = wasm_f32x4_splat(0.0f);
    const v128_t v255 = wasm_f32x4_splat(255.0f);
    const v128_t vByteMask = wasm_i32x4_splat(0xFF);
    const v128_t v255recip = wasm_f32x4_splat(1.0f / 255.0f);
    uint8_t* dst = s.layerBytes +
        (static_cast<ptrdiff_t>(py - s.layerOY) * s.layerW + (px - s.layerOX)) * 4;
    const v128_t vOrig = wasm_v128_load(dst);
    const v128_t vEr = wasm_f32x4_convert_i32x4(wasm_v128_and(vOrig, vByteMask));
    const v128_t vEg = wasm_f32x4_convert_i32x4(wasm_v128_and(wasm_u32x4_shr(vOrig, 8), vByteMask));
    const v128_t vEb = wasm_f32x4_convert_i32x4(wasm_v128_and(wasm_u32x4_shr(vOrig, 16), vByteMask));
    const v128_t vEa = wasm_f32x4_mul(wasm_f32x4_convert_i32x4(wasm_u32x4_shr(vOrig, 24)), v255recip);
    const v128_t vBlendA = wasm_v128_load(laneBlendA);
    const v128_t vBias = wasm_v128_load(laneBias);
    const v128_t vDstBlend = wasm_f32x4_mul(vEa, wasm_f32x4_sub(vOne, vBlendA));
    const v128_t vOutA = wasm_f32x4_add(vBlendA, vDstBlend);
    const v128_t vInvOutA = wasm_f32x4_div(vOne, wasm_f32x4_max(vOutA, wasm_f32x4_splat(1.0e-30f)));
    auto chan = [&](float src8, v128_t vE) -> v128_t {
        const v128_t v = wasm_f32x4_mul(
            wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_splat(src8), vBlendA),
                           wasm_f32x4_mul(vE, vDstBlend)), vInvOutA);
        const v128_t cl = wasm_f32x4_max(wasm_f32x4_min(wasm_f32x4_add(v, vBias), v255), vZero);
        return wasm_i32x4_trunc_sat_f32x4(cl);
    };
    v128_t vR = chan(s.r8, vEr);
    v128_t vG = chan(s.g8, vEg);
    v128_t vB = chan(s.b8, vEb);
    v128_t vA = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_max(wasm_f32x4_min(
        wasm_f32x4_add(wasm_f32x4_mul(vOutA, v255), vBias), v255), vZero));
    // outA ≤ 0 lanes become transparent black (matches `composite`).
    const v128_t vOutAPos = wasm_f32x4_gt(vOutA, vZero);
    vR = wasm_v128_and(vR, vOutAPos);
    vG = wasm_v128_and(vG, vOutAPos);
    vB = wasm_v128_and(vB, vOutAPos);
    vA = wasm_v128_and(vA, vOutAPos);
    const v128_t vPacked = wasm_v128_or(
        wasm_v128_or(vR, wasm_i32x4_shl(vG, 8)),
        wasm_v128_or(wasm_i32x4_shl(vB, 16), wasm_i32x4_shl(vA, 24)));
    wasm_v128_store(dst, wasm_v128_bitselect(vPacked, vOrig, wasm_v128_load(laneMask)));
}

// Procedural tip coverage for four lanes. Mirrors `procedural_coverage`.
BS_INLINE v128_t procedural_coverage4(
    const Stamp& s, v128_t vU, v128_t vV, bool sweep
) {
    const v128_t vOne = wasm_f32x4_splat(1.0f);
    const v128_t vZero = wasm_f32x4_splat(0.0f);
    v128_t vSdf, vDist;
    v128_t vAhead = wasm_i32x4_splat(-1);
    // Softness divides by the local radius when sweeping (k varies along
    // the segment); 1 otherwise.
    v128_t vK = vOne;
    if (s.tipKind == 0 && sweep) {
        const v128_t vSu = wasm_f32x4_splat(s.su);
        const v128_t vSv = wasm_f32x4_splat(s.sv);
        v128_t vT = wasm_f32x4_mul(
            wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_sub(vU, vSu), vSu),
                           wasm_f32x4_mul(wasm_f32x4_sub(vV, vSv), vSv)),
            wasm_f32x4_splat(-s.sInvLen2));
        // Behind the segment start → 0 (see swept_round_coverage).
        vAhead = wasm_f32x4_ge(vT, vZero);
        if (!wasm_v128_any_true(vAhead)) return vZero;
        vT = wasm_f32x4_min(wasm_f32x4_max(vT, vZero), vOne);
        const v128_t vW = wasm_f32x4_sub(vOne, vT);
        const v128_t vCu = wasm_f32x4_sub(vU, wasm_f32x4_mul(vSu, vW));
        const v128_t vCv = wasm_f32x4_sub(vV, wasm_f32x4_mul(vSv, vW));
        const v128_t vLen = wasm_f32x4_sqrt(
            wasm_f32x4_add(wasm_f32x4_mul(vCu, vCu), wasm_f32x4_mul(vCv, vCv)));
        vK = wasm_f32x4_add(wasm_f32x4_splat(s.sK0),
                            wasm_f32x4_mul(wasm_f32x4_splat(1.0f - s.sK0), vT));
        vSdf = wasm_f32x4_sub(vLen, vK);
        if (s.constGrad > 0.0f) {
            vDist = wasm_f32x4_mul(vSdf, wasm_f32x4_splat(s.invConstGrad));
        } else {
            const v128_t vUs = wasm_f32x4_mul(vCu, wasm_f32x4_splat(s.invR));
            const v128_t vVs = wasm_f32x4_mul(vCv, wasm_f32x4_splat(s.invRY));
            const v128_t vGrad = wasm_f32x4_div(
                wasm_f32x4_sqrt(wasm_f32x4_add(wasm_f32x4_mul(vUs, vUs), wasm_f32x4_mul(vVs, vVs))),
                wasm_f32x4_max(vLen, wasm_f32x4_splat(1e-6f)));
            vDist = wasm_f32x4_div(vSdf, wasm_f32x4_max(vGrad, wasm_f32x4_splat(1e-12f)));
        }
    } else if (s.tipKind == 0) {
        const v128_t vLen = wasm_f32x4_sqrt(
            wasm_f32x4_add(wasm_f32x4_mul(vU, vU), wasm_f32x4_mul(vV, vV)));
        vSdf = wasm_f32x4_sub(vLen, vOne);
        if (s.constGrad > 0.0f) {
            vDist = wasm_f32x4_mul(vSdf, wasm_f32x4_splat(s.invConstGrad));
        } else {
            const v128_t vUs = wasm_f32x4_mul(vU, wasm_f32x4_splat(s.invR));
            const v128_t vVs = wasm_f32x4_mul(vV, wasm_f32x4_splat(s.invRY));
            const v128_t vGrad = wasm_f32x4_div(
                wasm_f32x4_sqrt(wasm_f32x4_add(wasm_f32x4_mul(vUs, vUs), wasm_f32x4_mul(vVs, vVs))),
                wasm_f32x4_max(vLen, wasm_f32x4_splat(1e-6f)));
            vDist = wasm_f32x4_div(vSdf, wasm_f32x4_max(vGrad, wasm_f32x4_splat(1e-12f)));
        }
    } else if (s.tipKind == 1) {
        const v128_t vAu = wasm_f32x4_abs(vU);
        const v128_t vAv = wasm_f32x4_abs(vV);
        const v128_t vUMajor = wasm_f32x4_gt(vAu, vAv);
        vSdf = wasm_f32x4_sub(wasm_v128_bitselect(vAu, vAv, vUMajor), vOne);
        // 1 / gradient: radius along the dominant axis.
        vDist = wasm_f32x4_mul(vSdf, wasm_v128_bitselect(
            wasm_f32x4_splat(s.radius), wasm_f32x4_splat(s.radiusY), vUMajor));
    } else {
        vSdf = wasm_f32x4_sub(wasm_f32x4_add(wasm_f32x4_abs(vU), wasm_f32x4_abs(vV)), vOne);
        vDist = wasm_f32x4_mul(vSdf, wasm_f32x4_splat(s.invConstGrad));
    }
    v128_t vCov;
    if (s.aa) {
        vCov = wasm_f32x4_min(wasm_f32x4_max(
            wasm_f32x4_sub(wasm_f32x4_splat(0.5f), vDist), vZero), vOne);
    } else {
        vCov = wasm_v128_bitselect(vOne, vZero, wasm_f32x4_le(vSdf, vZero));
    }
    if (s.softness > 0.0f) {
        v128_t vX = wasm_f32x4_mul(wasm_f32x4_neg(vSdf), wasm_f32x4_splat(s.invSoftness));
        if (sweep) vX = wasm_f32x4_div(vX, vK);
        vX = wasm_f32x4_min(wasm_f32x4_max(vX, vZero), vOne);
        const v128_t vSmooth = wasm_f32x4_mul(wasm_f32x4_mul(vX, vX),
            wasm_f32x4_sub(wasm_f32x4_splat(3.0f), wasm_f32x4_mul(wasm_f32x4_splat(2.0f), vX)));
        vCov = wasm_f32x4_mul(vCov, vSmooth);
    }
    return wasm_v128_and(vCov, vAhead);
}
#endif

} // anonymous namespace

extern "C" void brush_bake_coverage(
    const BrushStampParams* p,
    uint8_t*                out_bitmap,
    int                     bm_w,
    int                     bm_h,
    const float*            tip_data,
    int                     tip_w,
    int                     tip_h,
    const float*            dual_tip_data,
    int                     dual_tip_w,
    int                     dual_tip_h
) {
    Stamp s;
    init_stamp(s, p, nullptr, nullptr, nullptr,
               TipTex{tip_data, tip_w, tip_h}, TipTex{dual_tip_data, dual_tip_w, dual_tip_h});
    s.sweep = false;  // the bake is one plain dab
    if (s.radius < 0.5f) {
        for (ptrdiff_t i = 0; i < static_cast<ptrdiff_t>(bm_w) * bm_h; i++) out_bitmap[i] = 0;
        return;
    }
    // Bitmap origin = stamp centre at the bitmap's integer centre, so the
    // per-stamp dispatch places it with `bm_offset = round(cx) - half`.
    // Only tip-local multiply grain is baked: canvas-locked grain depends
    // on the stamp position and subtract grain on its opacity.
    const bool bakeGrain = s.grainOn && s.grainFollows && !s.grainSubtract;
    const int halfX = bm_w / 2;
    const int halfY = bm_h / 2;
    for (int by = 0; by < bm_h; by++) {
        const float dy = (float)(by - halfY);
        uint8_t* row = out_bitmap + static_cast<ptrdiff_t>(by) * bm_w;
        for (int bx = 0; bx < bm_w; bx++) {
            const float dx = (float)(bx - halfX);
            float lx, ly;
            to_tip_local(s, dx, dy, lx, ly);
            float coverage = shape_coverage(s, lx, ly);
            if (coverage > 0.0f && s.dualOn) coverage *= dual_modulation(s, dx, dy);
            if (coverage > 0.0f && bakeGrain) coverage = apply_grain(s, coverage, lx, ly);
            row[bx] = to_byte_nearest(coverage);
        }
    }
}

extern "C" void brush_stamp_bitmap(
    const BrushStampParams* p,
    void*                   layer_data,
    uint8_t*                touched_data,
    const uint8_t*          sel_mask,
    const uint8_t*          bitmap,
    int                     bm_w,
    int                     bm_h
) {
    Stamp s;
    init_stamp(s, p, layer_data, touched_data, sel_mask, TipTex{nullptr, 0, 0}, TipTex{nullptr, 0, 0});
    s.tiled = false;
    // Dual and tip-local grain are baked; canvas-locked grain is per pixel.
    const bool grainHere = s.grainOn && !s.grainFollows;
    const int bmOX = p->bm_offset_x;
    const int bmOY = p->bm_offset_y;

    // Clip to canvas ∩ layer ∩ bbox ∩ bitmap.
    int x0 = p->min_x, y0 = p->min_y, x1 = p->max_x, y1 = p->max_y;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x0 < s.layerOX) x0 = s.layerOX;
    if (y0 < s.layerOY) y0 = s.layerOY;
    if (x0 < bmOX) x0 = bmOX;
    if (y0 < bmOY) y0 = bmOY;
    if (x1 > s.canvasW - 1) x1 = s.canvasW - 1;
    if (y1 > s.canvasH - 1) y1 = s.canvasH - 1;
    if (x1 > s.layerOX + s.layerW - 1) x1 = s.layerOX + s.layerW - 1;
    if (y1 > s.layerOY + s.layerH - 1) y1 = s.layerOY + s.layerH - 1;
    if (x1 > bmOX + bm_w - 1) x1 = bmOX + bm_w - 1;
    if (y1 > bmOY + bm_h - 1) y1 = bmOY + bm_h - 1;
    if (x1 < x0 || y1 < y0) return;

    for (int py = y0; py <= y1; py++) {
        const uint8_t* bmRow = bitmap + static_cast<ptrdiff_t>(py - bmOY) * bm_w;
        const uint8_t* tRow = touched_data + static_cast<ptrdiff_t>(py) * s.touchedW;
        int px = x0;
#ifdef __wasm_simd128__
        const bool fastRow = !s.isF32 && s.sel == nullptr && !grainHere && !s.bypassCap;
        for (; px + 3 <= x1; px += 4) {
            uint32_t cov4;
            __builtin_memcpy(&cov4, bmRow + (px - bmOX), 4);
            if (cov4 == 0) continue;
            if (group_saturated(s, tRow + px)) continue;
            alignas(16) float laneCov[4];
            for (int lane = 0; lane < 4; lane++) {
                laneCov[lane] = (float)bmRow[px - bmOX + lane] * (1.0f / 255.0f);
            }
            if (fastRow) {
                blend_group_rgba8(s, px, py, laneCov);
                continue;
            }
            for (int lane = 0; lane < 4; lane++) {
                float c = laneCov[lane];
                if (c <= 0.0f) continue;
                if (grainHere) c = modulate(s, c, px + lane, py, false, true);
                if (c > 0.0f) blend_pixel(s, px + lane, py, c);
            }
        }
#endif
        for (; px <= x1; px++) {
            const uint8_t cb = bmRow[px - bmOX];
            if (cb == 0) continue;
            float c = (float)cb * (1.0f / 255.0f);
            if (grainHere) c = modulate(s, c, px, py, false, true);
            if (c > 0.0f) blend_pixel(s, px, py, c);
        }
    }
}

extern "C" void brush_stamp(
    const BrushStampParams* p,
    void*                   layer_data,
    uint8_t*                touched_data,
    const uint8_t*          sel_mask,
    const float*            tip_data,
    int                     tip_w,
    int                     tip_h,
    const float*            dual_tip_data,
    int                     dual_tip_w,
    int                     dual_tip_h
) {
    if (p->radius < 0.5f) return;
    Stamp s;
    init_stamp(s, p, layer_data, touched_data, sel_mask,
               TipTex{tip_data, tip_w, tip_h}, TipTex{dual_tip_data, dual_tip_w, dual_tip_h});

    // ── Stamp-level saturation pre-scan ───────────────────────────────
    // If every coverage byte in the bbox is already at the saturation
    // threshold this stamp is a no-op: bail before any per-pixel work.
    // Heavily overlapping interior stamps of a dragged stroke hit this.
    if (s.maxTouchedByte <= 255 && !s.tiled) {
        const int rowLen = p->max_x - p->min_x + 1;
        if (rowLen > 0) {
            bool allSat = true;
#ifdef __wasm_simd128__
            const v128_t vThreshold = wasm_u8x16_splat((uint8_t)s.maxTouchedByte);
#endif
            for (int py = p->min_y; py <= p->max_y && allSat; py++) {
                const uint8_t* row = touched_data + static_cast<ptrdiff_t>(py) * s.touchedW + p->min_x;
                int x = 0;
#ifdef __wasm_simd128__
                for (; x + 15 < rowLen; x += 16) {
                    // Non-zero exactly where row < threshold.
                    if (wasm_v128_any_true(wasm_u8x16_sub_sat(vThreshold, wasm_v128_load(row + x)))) {
                        allSat = false;
                        break;
                    }
                }
#endif
                if (allSat) {
                    for (; x < rowLen; x++) {
                        if ((int)row[x] < s.maxTouchedByte) { allSat = false; break; }
                    }
                }
            }
            if (allSat) return;
        }
    }

#ifdef __wasm_simd128__
    // ── SIMD path (procedural tips, not tiled) ────────────────────────
    // Tip coverage for 4 pixels at a time; the per-pixel accumulate and
    // composite stay scalar except for the rgba8 / no-selection / no
    // modulation case, which blends all four lanes in one go.
    if (s.tipKind != 3 && !s.tiled) {
        const bool needsModulation = s.dualOn || s.grainOn;
        const v128_t vCx = wasm_f32x4_splat(s.cx);
        const v128_t vLaneOff = wasm_f32x4_make(0.0f, 1.0f, 2.0f, 3.0f);
        const v128_t vCos = wasm_f32x4_splat(s.cosT);
        const v128_t vSin = wasm_f32x4_splat(s.sinT);
        const v128_t vShear = wasm_f32x4_splat(s.shear);
        const v128_t vFx = wasm_f32x4_splat(s.fxFlip);
        const v128_t vFy = wasm_f32x4_splat(s.fyFlip);
        const v128_t vInvR = wasm_f32x4_splat(s.invR);
        const v128_t vInvRY = wasm_f32x4_splat(s.invRY);
        const v128_t vZero = wasm_f32x4_splat(0.0f);

        for (int py = p->min_y; py <= p->max_y; py++) {
            const v128_t vDy = wasm_f32x4_splat((float)py - s.cy);
            const uint8_t* tRow = touched_data + static_cast<ptrdiff_t>(py) * s.touchedW;
            const int ly = py - s.layerOY;
            const bool rowInLayer = ly >= 0 && ly < s.layerH && py >= 0 && py < s.canvasH;
            int px = p->min_x;
            for (; px + 3 <= p->max_x; px += 4) {
                if (px >= 0 && px + 3 < s.canvasW && group_saturated(s, tRow + px)) continue;
                const v128_t vDx = wasm_f32x4_sub(
                    wasm_f32x4_add(wasm_f32x4_splat((float)px), vLaneOff), vCx);
                v128_t vLx = wasm_f32x4_add(wasm_f32x4_mul(vDx, vCos), wasm_f32x4_mul(vDy, vSin));
                v128_t vLy = wasm_f32x4_sub(wasm_f32x4_mul(vDy, vCos), wasm_f32x4_mul(vDx, vSin));
                vLx = wasm_f32x4_sub(vLx, wasm_f32x4_mul(vShear, vLy));
                vLx = wasm_f32x4_mul(vLx, vFx);
                vLy = wasm_f32x4_mul(vLy, vFy);
                const v128_t vCov = procedural_coverage4(
                    s, wasm_f32x4_mul(vLx, vInvR), wasm_f32x4_mul(vLy, vInvRY), s.sweep);
                if (!wasm_v128_any_true(wasm_f32x4_gt(vCov, vZero))) continue;
                alignas(16) float laneCov[4];
                wasm_v128_store(laneCov, vCov);

                const int lx0 = px - s.layerOX;
                const bool fastGroup =
                    !s.isF32 && s.sel == nullptr && !needsModulation && !s.bypassCap &&
                    rowInLayer && px >= 0 && px + 3 < s.canvasW &&
                    lx0 >= 0 && lx0 + 3 < s.layerW;
                if (fastGroup) {
                    blend_group_rgba8(s, px, py, laneCov);
                    continue;
                }
                for (int lane = 0; lane < 4; lane++) {
                    float c = laneCov[lane];
                    if (c <= 0.0f) continue;
                    if (needsModulation) c = modulate(s, c, px + lane, py, true, true);
                    if (c > 0.0f) blend_pixel(s, px + lane, py, c);
                }
            }
            // Scalar tail (0–3 pixels).
            for (; px <= p->max_x; px++) {
                float lx, lyT;
                to_tip_local(s, (float)px - s.cx, (float)py - s.cy, lx, lyT);
                float c = shape_coverage(s, lx, lyT);
                if (c <= 0.0f) continue;
                if (needsModulation) c = modulate(s, c, px, py, true, true);
                if (c > 0.0f) blend_pixel(s, px, py, c);
            }
        }
        return;
    }
#endif

    // ── Scalar path (bitmap tips, tiled mode, or no SIMD) ─────────────
    for (int py = p->min_y; py <= p->max_y; py++) {
        const float dy = (float)py - s.cy;
        for (int px = p->min_x; px <= p->max_x; px++) {
            // Saturation precheck before the tip compute (non-tiled only:
            // tiled pixels wrap to a different coverage-buffer entry).
            if (!s.tiled && s.maxTouchedByte <= 255 &&
                px >= 0 && px < s.canvasW && py >= 0 && py < s.canvasH &&
                (int)touched_data[static_cast<ptrdiff_t>(py) * s.touchedW + px] >= s.maxTouchedByte) {
                continue;
            }
            float lx, ly;
            to_tip_local(s, (float)px - s.cx, dy, lx, ly);
            float c = shape_coverage(s, lx, ly);
            if (c <= 0.0f) continue;
            c = modulate(s, c, px, py, true, true);
            if (c > 0.0f) blend_pixel(s, px, py, c);
        }
    }
}
