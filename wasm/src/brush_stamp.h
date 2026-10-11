// brush_stamp.h
//
// Inner pixel loop for the brush stamp engine (src/core/tools/Brush/
// stampEngine.ts). The JS side resolves all per-stamp parameters (size,
// angle, colour, opacity, flow, dynamics) and asks this kernel to paint the
// stamp's per-pixel coverage into the layer + the per-stroke coverage
// buffer.
//
// Scope of this kernel:
//   * Tip kinds 0..3: round / square / diamond (analytic SDF with a
//     hardness-sized opaque core, a smooth falloff inside the radius and a
//     1 px anti-aliased edge) and bitmap (a sampled paint-density map, one
//     mip level chosen JS-side for the dab size).
//   * Swept round dabs: a capsule from the previous dab's centre, so round
//     strokes have no ripple between dabs.
//   * Layer formats rgba8 + rgba32f (no indexed8 — palette write stays in JS).
//   * Opacity / Flow accumulation against the per-stroke coverage buffer,
//     bypass-cap mode and the "stamp == cap" path.
//   * Stochastic rounding of every 8-bit write (layer channels and the
//     coverage buffer), so low-flow glazes converge on the target colour
//     instead of stalling on rounding, and soft falloffs don't band.
//   * Selection mask + tiled-mode wrap.
//   * Dual brush (second tip multiplied into coverage).
//   * Paper grain (fBm value noise; multiply or subtract mode, tip-local or
//     canvas-locked).
//   * Pre-rasterized bitmap fast path for static-shape strokes
//     (`brush_bake_coverage` + `brush_stamp_bitmap`, see below).
//
// Out of scope (caller falls back to JS):
//   * Smudge per-stamp pickup (stateful).
//   * Motion-blur elongation.
//
// Coverage math is mirrored in src/core/tools/Brush/tipSampler.ts and
// paperTexture.ts — keep them in sync.

#pragma once

#include <cstdint>

extern "C" {

// Packed parameter struct mirrored exactly on the TS side
// (src/wasm/brushStamp.ts PARAM_F / PARAM_I). Keep field order stable.
// 208 bytes of fields; `alignas(16)` keeps `sizeof(BrushStampParams)` at
// exactly 208 to match the JS-side `PARAM_BYTES` stride used by the batched
// dispatch.
struct alignas(16) BrushStampParams {
    // Geometry
    float cx, cy;          // stamp centre, canvas-pixel space (pixel centres at integers)
    float radius;          // stamp radius (px)
    float roundness;       // 0.05..1
    float angle;           // radians
    float shear;           // tip-local x shear along y
    float aa;              // > 0: anti-aliased edge; 0: aliased
    // Color
    float fr, fg, fb, fa;  // rgba32f path (linear-light, pre-decoded JS-side)
    int   r, g, b, a;      // 0..255 for rgba8 path
    // Blend
    float opacity;         // 0..100, this stamp's per-pixel base deposit
    float cap_opacity;     // 0..100, per-stroke ceiling. <0 = no cap.
    // Bbox (canvas-pixel space, integer, inclusive)
    int   min_x, min_y, max_x, max_y;
    int   flip_x, flip_y;  // ±1
    // Tip
    int   tip_kind;        // 0=round, 1=square, 2=diamond, 3=bitmap
    int   bypass_cap;      // 0 or 1
    // Layer extent (so we can map canvas → layer-local)
    int   layer_offset_x, layer_offset_y;
    int   layer_w, layer_h;
    // Touched buffer extent (always == canvas)
    int   touched_w, touched_h;
    // Tiled mode
    int   tiled;           // 0/1
    int   tiled_w, tiled_h;
    // Layer format: 0 = rgba8, 1 = rgba32f
    int   layer_format;
    // ── Dual brush ─────────────────────────────────────────────────────
    int   dual_active;       // 0/1
    int   dual_tip_kind;     // 0=round, 1=square, 2=diamond, 3=bitmap
    float dual_size_ratio;   // dual radius = primary radius × this
    float dual_base_angle;   // total rotation in radians
    float dual_mix;          // 0..1, lerp from identity to full multiply
    // ── Paper grain ────────────────────────────────────────────────────
    float grain_amount;      // 0..1 (0 disables)
    float grain_scale;       // pixels per noise period (≥ 2)
    int   grain_follow_brush; // 1 = sample in tip-local; 0 = canvas-locked
    // ── Pre-rasterized bitmap path: bitmap pixel (0,0) sits at canvas
    //     pixel (bm_offset_x, bm_offset_y). ──────────────────────────────
    int   bm_offset_x;
    int   bm_offset_y;
    // ── Appended fields ────────────────────────────────────────────────
    float softness;          // 0..1 — falloff depth as a fraction of the radius (1 − hardness)
    int   dither_seed;       // per-stamp seed for the stochastic rounding
    int   grain_mode;        // 0 = multiply, 1 = subtract
    // ── Swept dab (round tips) ─────────────────────────────────────────
    // The dab is swept from the previous dab's centre (this offset, canvas
    // px) to its own, the radius interpolating from `sweep_r0` × radius:
    // coverage is the continuous stroke's, with no ripple between dabs.
    // (0, 0) = a plain dab.
    float sweep_dx, sweep_dy;
    float sweep_r0;
    int   sweep_pad;
};

// Kernel: apply one stamp into the supplied buffers.
//
// `layer_data`   — the layer's pixels: rgba8 = uint8_t[layer_w * layer_h * 4],
//                  rgba32f = float[layer_w * layer_h * 4]. Read + written in place.
// `touched_data` — uint8_t[canvas_w * canvas_h], the per-stroke coverage buffer.
// `sel_mask`     — optional uint8_t[canvas_w * canvas_h] selection (0 = blocked).
// `tip_data`/`tip_w`/`tip_h` — tip_kind == 3 only: the density mip level
//                  (float 0..1, row-major) to sample.
// `dual_tip_data`/… — the same for the dual tip when `dual_tip_kind == 3`.
void brush_stamp(
    const BrushStampParams* params,
    void*                   layer_data,
    uint8_t*                touched_data,
    const uint8_t*          sel_mask,
    const float*            tip_data,
    int                     tip_w,
    int                     tip_h,
    const float*            dual_tip_data,
    int                     dual_tip_w,
    int                     dual_tip_h
);

// ── Pre-rasterized bitmap path ─────────────────────────────────────────
//
// For brushes whose *shape* is stable across a segment (no per-stamp size
// /angle/roundness/flip dynamics, no pose-driven shape changes), the full
// coverage map is rasterized once into an 8-bit bitmap and each stamp just
// blits it with the per-pixel cap check. Eliminates the per-pixel tip
// compute — the dominant cost for big soft brushes, whose falloff never
// saturates the coverage buffer. Stamps land on whole pixels, so the JS side
// only uses this path when the falloff is wide enough to hide that.
//
// `brush_bake_coverage` reads only the shape fields of `params` (plus dual
// and tip-local multiply grain); `brush_stamp_bitmap` reads only the
// per-stamp fields (bm_offset_*, colour, opacity, cap, bbox, layer extents,
// canvas-locked grain, dither seed).
void brush_bake_coverage(
    const BrushStampParams* params,
    uint8_t*                out_bitmap,
    int                     bm_w,
    int                     bm_h,
    const float*            tip_data,
    int                     tip_w,
    int                     tip_h,
    const float*            dual_tip_data,
    int                     dual_tip_w,
    int                     dual_tip_h
);

void brush_stamp_bitmap(
    const BrushStampParams* params,
    void*                   layer_data,
    uint8_t*                touched_data,
    const uint8_t*          sel_mask,
    const uint8_t*          bitmap,
    int                     bm_w,
    int                     bm_h
);

} // extern "C"
