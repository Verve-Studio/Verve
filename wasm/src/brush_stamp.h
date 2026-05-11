// brush_stamp.h
//
// Inner pixel loop for the brush stamp engine, ported from
// `applyStamp` in src/core/tools/Brush/stampEngine.ts. The JS side
// resolves all per-stamp parameters (size, angle, color, opacity,
// dynamics) and asks this kernel to paint the per-pixel coverage into
// a sliced layer buffer + per-pixel max-coverage buffer.
//
// Scope of this kernel:
//   * Tip kinds 0..3 (round / square / diamond / bitmap-SDF).
//   * Layer formats rgba8 + rgba32f (no indexed8 — palette write
//     stays in JS).
//   * Cap-vs-flow blending (Photoshop Opacity / Flow), bypass-cap mode
//     (smudge / build-up tick), and the legacy "stamp == cap" path.
//   * Selection mask + tiled-mode wrap.
//
// Out of scope (caller falls back to JS):
//   * Smudge per-stamp pickup (stateful, tiny per-stamp benefit).
//   * Dual brush (per-pixel second tip — a future commit can add).
//   * Paper grain (smooth value noise — straightforward to port later).
//   * Motion-blur elongation (rare, complex inverse transform).

#pragma once

#include <cstdint>

extern "C" {

// Packed parameter struct mirrored exactly on the TS side. Keep field
// order stable — the JS wrapper writes a Float32Array / Int32Array view
// of the same offsets. Field bytes used: 180; struct padded to 192 via
// `alignas(16)` so the C++ stride `sizeof(BrushStampParams)` matches the
// JS-side `PARAM_BYTES = 192` exactly. Without this, batched dispatch
// reads from a different offset than JS wrote to past the first entry
// (silent corruption for `_pixelops_brush_stamp_batch`).
struct alignas(16) BrushStampParams {
    // Geometry
    float cx, cy;          // stamp centre, canvas-pixel space (float)
    float radius;          // stamp radius (px)
    float roundness;       // 0.05..1
    float angle;           // radians
    float shear;           // tip-local x shear along y
    float aa_width;        // AA half-width in pixels (0 = no AA)
    // Color (sRGB-encoded floats, 0..1+)
    float fr, fg, fb, fa;  // for rgba32f path (linear-light if pre-decoded)
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
    // When dual_active != 0, after computing the primary tip's coverage
    // we sample a *second* tip in its own rotated/scaled frame and
    // multiply that into the coverage. Lets WASM handle natural-media
    // brushes (charcoal / oil / dry-brush) without falling back to JS.
    int   dual_active;       // 0/1
    int   dual_tip_kind;     // 0=round, 1=square, 2=diamond, 3=bitmap
    float dual_size_ratio;   // dual radius = primary radius × this
    float dual_base_angle;   // total rotation in radians
    float dual_mix;          // 0..1, lerp from identity to full multiply
    // ── Paper grain ────────────────────────────────────────────────────
    // Per-pixel value-noise modulation of coverage. amount=0 disables.
    float grain_amount;      // 0..1
    float grain_scale;       // pixels per noise period (≥ 2)
    int   grain_follow_brush; // 1 = sample in tip-local; 0 = canvas-locked
    // ── Pre-rasterized bitmap path (when bitmap != null in the kernel
    //     call). Per-stamp offsets that locate the bitmap in canvas
    //     coords: bitmap pixel (0,0) corresponds to canvas pixel
    //     (bm_offset_x, bm_offset_y). Computed JS-side as
    //     `round(cx - bmHalfX)`.
    int   bm_offset_x;
    int   bm_offset_y;
};

// Kernel: apply one stamp into the supplied buffers.
//
// `layer_data`        — pointer to the layer's pixel buffer, shape depends on
//                       layer_format: rgba8 = uint8_t[layer_w * layer_h * 4],
//                       rgba32f = float[layer_w * layer_h * 4]. The kernel
//                       reads + writes in place.
// `touched_data`      — uint8_t[canvas_w * canvas_h], the per-stroke max
//                       coverage byte-buffer.
// `sel_mask`          — optional uint8_t[canvas_w * canvas_h] selection mask
//                       (0 = blocked). null = no selection.
// `sdf_data`/`sdf_w`/`sdf_h` — only used for tip_kind == 3 (bitmap). The SDF
//                       is in pixel-distance units; the kernel applies the
//                       same unit-scale mapping the JS BitmapSdfSampler uses.
// `dual_sdf_data`/`dual_sdf_w`/`dual_sdf_h` — same, for the dual tip when
//                       `dual_tip_kind == 3`. Null otherwise.
//
// Returns: nothing. The buffers are mutated in place.
void brush_stamp(
    const BrushStampParams* params,
    void*                   layer_data,
    uint8_t*                touched_data,
    const uint8_t*          sel_mask,
    const float*            sdf_data,
    int                     sdf_w,
    int                     sdf_h,
    const float*            dual_sdf_data,
    int                     dual_sdf_w,
    int                     dual_sdf_h
);

// ── Pre-rasterized bitmap path ─────────────────────────────────────────
//
// For brushes whose *shape* is stable across a stroke (no per-stamp size
// /angle/roundness/flip jitter, no pose-driven shape changes, no motion
// blur), we can pre-rasterize the full coverage map into an 8-bit
// bitmap once and then per-stamp just blit it into the layer with a
// per-pixel cap check. Eliminates the per-pixel SDF compute + smoothstep
// + dual + (followBrush) grain — the dominant cost for soft brushes,
// where the AA falloff band is enormous and never saturates the touched
// buffer (so the existing saturation prechecks don't help).
//
// Strategy:
//   * `brush_bake_coverage` walks a `(bm_w × bm_h)` bitmap and writes the
//     coverage byte (0..255) at each cell, applying the same SDF + AA +
//     optional dual + optional followBrush-grain math the SDF kernel
//     uses per-pixel per-stamp. Called once per stroke at the design
//     shape — JS sizes the bitmap to fit the stamp bbox at that shape.
//   * `brush_stamp_bitmap` per-stamp: clip the bitmap rect to canvas +
//     layer, walk the intersection, read each byte from the bitmap (no
//     SDF compute), apply per-pixel cap check + canvas-locked grain (if
//     applicable) + Porter-Duff blend. SIMD-vectorised across 4 lanes
//     just like the SDF path.
//
// `params` reuses BrushStampParams; only the *per-stamp* fields are
// consulted (cx/cy → bm_offset_*, color, opacity, cap, bbox, layer
// extents, grain canvas-locked params). Shape fields (radius, angle,
// roundness, …) are ignored on this path because their effect is
// already baked into the bitmap.
void brush_bake_coverage(
    const BrushStampParams* params,
    uint8_t*                out_bitmap,
    int                     bm_w,
    int                     bm_h,
    const float*            sdf_data,
    int                     sdf_w,
    int                     sdf_h,
    const float*            dual_sdf_data,
    int                     dual_sdf_w,
    int                     dual_sdf_h
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
