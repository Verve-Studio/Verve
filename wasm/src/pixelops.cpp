/**
 * pixelops.cpp
 *
 * Exported C interface for all WASM pixel operations.
 * Each function is declared EMSCRIPTEN_KEEPALIVE so the linker retains it
 * even if it would otherwise be dead-stripped.
 *
 * Memory convention:
 *   Callers allocate buffers via malloc / free (exported by Emscripten).
 *   Pixel buffers are always RGBA, row-major, 4 bytes per pixel.
 */

#include <emscripten/emscripten.h>
#include <cstdint>
#include <climits>
#include <vector>

#include "fill.h"
#include "filters.h"
#include "quantize.h"
#include "resize.h"
#include "dither.h"
#include "curves_histogram.h"
#include "transform.h"
#include "inpaint.h"
#include "grabcut.h"
#include "dds.h"
#include "brush_stamp.h"

extern "C" {

// ─── Flood Fill ───────────────────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_flood_fill(
    uint8_t* pixels, int width, int height,
    int startX, int startY,
    uint8_t fillR, uint8_t fillG, uint8_t fillB, uint8_t fillA,
    int tolerance
) {
    fill_flood(pixels, width, height, startX, startY,
               fillR, fillG, fillB, fillA, tolerance);
}

EMSCRIPTEN_KEEPALIVE
void pixelops_flood_fill_f32(
    float* pixels, int width, int height,
    int startX, int startY,
    float fillR, float fillG, float fillB, float fillA,
    float tolerance
) {
    fill_flood_f32(pixels, width, height, startX, startY,
                   fillR, fillG, fillB, fillA, tolerance);
}

// ─── Generic Convolution (src → dst) ─────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_convolve(
    const uint8_t* src, uint8_t* dst,
    int width, int height,
    const float* kernel, int kernelSize
) {
    filters_convolve(src, dst, width, height, kernel, kernelSize);
}

// ─── Bilinear Resize ─────────────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_resize_bilinear(
    const uint8_t* src, int srcWidth, int srcHeight,
    uint8_t* dst, int dstWidth, int dstHeight
) {
    resize_bilinear(src, srcWidth, srcHeight, dst, dstWidth, dstHeight);
}

// ─── Nearest-Neighbour Resize ────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_resize_nearest(
    const uint8_t* src, int srcWidth, int srcHeight,
    uint8_t* dst, int dstWidth, int dstHeight
) {
    resize_nearest(src, srcWidth, srcHeight, dst, dstWidth, dstHeight);
}


// ─── Bayer Ordered Dithering ─────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_dither_bayer(
    uint8_t* pixels, int width, int height, int matrixSize
) {
    dither_bayer(pixels, width, height, matrixSize);
}

// ─── Median-Cut Palette Quantisation ─────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
int pixelops_quantize(
    const uint8_t* pixels, int pixelCount,
    uint8_t* paletteOut, int maxColors
) {
    return quantize_median_cut(pixels, pixelCount, paletteOut, maxColors);
}

// ─── Curves Histogram ────────────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
float* pixelops_curves_histogram(
    const uint8_t* inputPtr, uint32_t width, uint32_t height,
    const uint8_t* maskPtr
) {
    return computeCurvesHistogram(inputPtr, width, height, maskPtr);
}


// ─── Affine Transform (src → dst, inverse-mapped) ───────────────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_affine_transform(
    const uint8_t* src, int srcW, int srcH,
    uint8_t* dst, int dstW, int dstH,
    const float* invMatrix,
    int interp
) {
    transform_affine(src, srcW, srcH, dst, dstW, dstH, invMatrix, interp);
}

// ─── Perspective Transform (src → dst, inverse homography) ──────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_perspective_transform(
    const uint8_t* src, int srcW, int srcH,
    uint8_t* dst, int dstW, int dstH,
    const float* invH,
    int interp
) {
    transform_perspective(src, srcW, srcH, dst, dstW, dstH, invH, interp);
}

// ─── Rotate RGBA ──────────────────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_rotate_rgba(
    const uint8_t* src, int srcW, int srcH,
    uint8_t* dst,
    int amount  // 0=90CW, 1=180, 2=270CW
) {
    rotate_rgba(src, srcW, srcH, dst, amount);
}

// ─── Flip RGBA ────────────────────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_flip_rgba(
    const uint8_t* src, int w, int h,
    uint8_t* dst,
    int axis  // 0=horizontal, 1=vertical
) {
    flip_rgba(src, w, h, dst, axis);
}

// ─── Rotate indexed ───────────────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_rotate_indexed(
    const uint8_t* src, int srcW, int srcH,
    uint8_t* dst,
    int amount  // 0=90CW, 1=180, 2=270CW
) {
    rotate_indexed(src, srcW, srcH, dst, amount);
}

// ─── Flip indexed ─────────────────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_flip_indexed(
    const uint8_t* src, int w, int h,
    uint8_t* dst,
    int axis  // 0=horizontal, 1=vertical
) {
    flip_indexed(src, w, h, dst, axis);
}

// ─── Content-Aware Inpainting (PatchMatch) ───────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_inpaint(
    const uint8_t* pixels, int width, int height,
    const uint8_t* mask, int patchSize,
    const uint8_t* sourceMask,  // nullable; 1=eligible source, 0=excluded. null=unconstrained.
    uint8_t* out
) {
    inpaint(pixels, width, height, mask, patchSize, sourceMask, out);
}

// ─── GrabCut Segmentation ─────────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_grabcut(
    const uint8_t* rgba, int width, int height,
    const uint8_t* trimap,  // 0=BG, 128=unknown, 255=FG
    uint8_t* alpha_out,     // output 0/255 per pixel
    int iterations,
    int k                   // GMM components per class (5 recommended)
) {
    grabcut(rgba, width, height, trimap, alpha_out, iterations, k);
}

// ─── GrabCut Hybrid Building Blocks ──────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
float pixelops_grabcut_compute_beta(
    const uint8_t* rgba, int width, int height
) {
    return grabcut_compute_beta(rgba, width, height);
}

EMSCRIPTEN_KEEPALIVE
void pixelops_grabcut_kmeans_init(
    const uint8_t* rgba, int width, int height,
    const uint8_t* trimap, int k, float* paramsOut
) {
    grabcut_kmeans_init(rgba, width, height, trimap, k, paramsOut);
}

EMSCRIPTEN_KEEPALIVE
void pixelops_grabcut_update_gmms(
    const uint8_t* rgba, int width, int height,
    const uint8_t* label, int k, float* paramsInOut
) {
    grabcut_update_gmms(rgba, width, height, label, k, paramsInOut);
}

EMSCRIPTEN_KEEPALIVE
void pixelops_grabcut_mincut(
    const float* capS, const float* capT,
    const float* hW, const float* vW,
    const uint8_t* trimap, int width, int height, uint8_t* labelOut
) {
    grabcut_mincut(capS, capT, hW, vW, trimap, width, height, labelOut);
}

// ─── Nearest-Palette-Index Mapping ──────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
void matchPaletteIndices(
  const uint8_t* rgba,       // input: pixelCount * 4 RGBA8 bytes
  int pixelCount,
  const uint8_t* palette,    // input: paletteSize * 4 RGBA8 entries
  int paletteSize,
  uint8_t* out,              // output: pixelCount bytes of palette indices
  int transparentIdx         // index to write when alpha == 0 or palette is empty
) {
  for (int i = 0; i < pixelCount; i++) {
    const uint8_t r = rgba[i*4], g = rgba[i*4+1], b = rgba[i*4+2], a = rgba[i*4+3];
    if (a == 0 || paletteSize == 0) { out[i] = (uint8_t)transparentIdx; continue; }
    int bestIdx = 0;
    long bestDist = LONG_MAX;
    for (int j = 0; j < paletteSize; j++) {
      int dr = (int)r - palette[j*4];
      int dg = (int)g - palette[j*4+1];
      int db = (int)b - palette[j*4+2];
      int da = (int)a - palette[j*4+3];
      long d = (long)dr*dr + (long)dg*dg + (long)db*db + (long)da*da;
      if (d < bestDist) { bestDist = d; bestIdx = j; }
    }
    out[i] = (uint8_t)bestIdx;
  }
}

} // extern "C"

// ─── Indexed-8 Flood Fill ────────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
void floodFillIndexed(
  uint8_t* indices,    // layer-local 1 byte/pixel buffer, modified in-place
  int w, int h,
  int startX, int startY,
  uint8_t fillIndex    // index to write (0-254); 255 = void
) {
  if (startX < 0 || startX >= w || startY < 0 || startY >= h) return;
  const uint8_t targetIndex = indices[startY * w + startX];
  if (targetIndex == fillIndex) return;

  // BFS 4-connected flood fill
  std::vector<int> stack;
  stack.reserve(w * h / 4);
  stack.push_back(startY * w + startX);
  while (!stack.empty()) {
    int pos = stack.back();
    stack.pop_back();
    if (indices[pos] != targetIndex) continue;
    indices[pos] = fillIndex;
    int x = pos % w, y = pos / w;
    if (x > 0)     stack.push_back(pos - 1);
    if (x < w - 1) stack.push_back(pos + 1);
    if (y > 0)     stack.push_back(pos - w);
    if (y < h - 1) stack.push_back(pos + w);
  }
}

// ─── DDS I/O ──────────────────────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
int pixelops_dds_get_info(const uint8_t *data, int32_t size, int32_t *out) {
    dds_info info;
    int err = dds_get_info(data, size, &info);
    if (err != DDS_OK) return err;
    out[0] = info.width;
    out[1] = info.height;
    out[2] = info.fmt;
    out[3] = info.mipLevels;
    return DDS_OK;
}

extern "C" EMSCRIPTEN_KEEPALIVE
int pixelops_dds_decode(const uint8_t *data, int32_t size, uint8_t *out, int32_t outSize) {
    return dds_decode(data, size, out, outSize);
}

extern "C" EMSCRIPTEN_KEEPALIVE
int pixelops_dds_decode_f32(const uint8_t *data, int32_t size, float *out, int32_t outSize) {
    return dds_decode_f32(data, size, out, outSize);
}

extern "C" EMSCRIPTEN_KEEPALIVE
int32_t pixelops_dds_get_encoded_size(int32_t width, int32_t height, int fmt, int mipLevels, int headerMode) {
    return dds_get_encoded_size(width, height, fmt, mipLevels, headerMode);
}

extern "C" EMSCRIPTEN_KEEPALIVE
int pixelops_dds_max_mip_levels(int32_t width, int32_t height, int minDim) {
    return dds_max_mip_levels(width, height, minDim);
}

extern "C" EMSCRIPTEN_KEEPALIVE
int pixelops_dds_encode(const uint8_t *pixels, int32_t width, int32_t height,
                        int fmt, int mipLevels, int headerMode, uint8_t *out, int32_t outSize) {
    return dds_encode(pixels, width, height, fmt, mipLevels, headerMode, out, outSize);
}

extern "C" EMSCRIPTEN_KEEPALIVE
int pixelops_dds_encode_f32(const float *pixels, int32_t width, int32_t height,
                             int fmt, int mipLevels, int headerMode, uint8_t *out, int32_t outSize) {
    return dds_encode_f32(pixels, width, height, fmt, mipLevels, headerMode, out, outSize);
}

// ─── Brush stamp (inner pixel loop) ───────────────────────────────────────────
// All parameters travel in a single packed struct so the JS side can write
// one Float32Array/Int32Array view per stamp instead of marshalling 30+
// separate scalar args through the WASM ABI.

extern "C" EMSCRIPTEN_KEEPALIVE
void pixelops_brush_stamp(
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
) {
    brush_stamp(params, layer_data, touched_data, sel_mask,
                sdf_data, sdf_w, sdf_h,
                dual_sdf_data, dual_sdf_w, dual_sdf_h);
}

// Batched form — process N stamps that share the same layer, touched,
// selection, and SDF context. The invariant ptrs are passed once and the
// per-stamp variations live in a tightly packed BrushStampParams array.
// Cuts ~13 µs of JS dispatch overhead per stamp (object alloc + DataView
// setters + WASM call boundary) and — more importantly — eliminates the
// per-stamp allocation that triggered young-gen GC mid-stroke.
extern "C" EMSCRIPTEN_KEEPALIVE
void pixelops_brush_stamp_batch(
    const BrushStampParams* params_array,
    int                     count,
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
    for (int i = 0; i < count; i++) {
        brush_stamp(&params_array[i], layer_data, touched_data, sel_mask,
                    sdf_data, sdf_w, sdf_h,
                    dual_sdf_data, dual_sdf_w, dual_sdf_h);
    }
}

// ── Pre-rasterized bitmap brush path ────────────────────────────────────
// See brush_stamp.h for the architecture. Rasterizing the brush shape into
// an 8-bit coverage bitmap once per stroke, then per-stamp blitting the
// bitmap, eliminates the per-pixel SDF + AA + dual + grain compute that
// dominates soft-brush cost (where the AA falloff band is huge and the
// touched saturation prechecks never fire).

extern "C" EMSCRIPTEN_KEEPALIVE
void pixelops_brush_bake_coverage(
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
) {
    brush_bake_coverage(params, out_bitmap, bm_w, bm_h,
                        sdf_data, sdf_w, sdf_h,
                        dual_sdf_data, dual_sdf_w, dual_sdf_h);
}

extern "C" EMSCRIPTEN_KEEPALIVE
void pixelops_brush_stamp_bitmap(
    const BrushStampParams* params,
    void*                   layer_data,
    uint8_t*                touched_data,
    const uint8_t*          sel_mask,
    const uint8_t*          bitmap,
    int                     bm_w,
    int                     bm_h
) {
    brush_stamp_bitmap(params, layer_data, touched_data, sel_mask,
                       bitmap, bm_w, bm_h);
}

extern "C" EMSCRIPTEN_KEEPALIVE
void pixelops_brush_stamp_bitmap_batch(
    const BrushStampParams* params_array,
    int                     count,
    void*                   layer_data,
    uint8_t*                touched_data,
    const uint8_t*          sel_mask,
    const uint8_t*          bitmap,
    int                     bm_w,
    int                     bm_h
) {
    for (int i = 0; i < count; i++) {
        brush_stamp_bitmap(&params_array[i], layer_data, touched_data, sel_mask,
                           bitmap, bm_w, bm_h);
    }
}
