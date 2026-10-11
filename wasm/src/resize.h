#pragma once
#include <cstdint>

/// Pixel formats of a layer buffer (match `PixelFormat` on the JS side).
enum ResizeLayerFormat : int {
    RESIZE_RGBA8 = 0,    ///< 4 × uint8, sRGB-encoded, straight alpha
    RESIZE_RGBA32F = 1,  ///< 4 × float, scene-linear, straight alpha (HDR > 1 kept)
    RESIZE_INDEXED8 = 2, ///< 1 × uint8 palette index, 255 = transparent
};

/// Resample one layer for Resize Image: the layer's layer-local buffer
/// (srcW × srcH at srcOx, srcOy on an oldCanvasW × oldCanvasH canvas) is
/// scaled by (scaleX, scaleY) into the output rect dstX, dstY, dstW × dstH
/// of the new canvas, in the layer's own format.
///
/// Positions are mapped in canvas space, so every layer stays registered;
/// they're clamped to the old canvas (edges extend rather than fade), and
/// samples outside the layer are transparent.
///  - filter 0: separable tent filter in premultiplied space — bilinear when
///    upscaling, widened to the source footprint (area-like) when
///    downscaling. rgba32f output isn't clamped.
///  - filter 1, and always for indexed8: nearest neighbour (indices are
///    copied, never interpolated).
///
/// Returns 0 on success, 1 when a working buffer couldn't be allocated.
int resize_layer(
    const void* src, int format, int srcW, int srcH, int srcOx, int srcOy,
    int oldCanvasW, int oldCanvasH, double scaleX, double scaleY,
    void* dst, int dstX, int dstY, int dstW, int dstH, int filter
);
