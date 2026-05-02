#pragma once
#include <cstdint>

/// Scanline flood fill with RGBA tolerance.
/// Pixels are stored row-major, 4 bytes per pixel (R,G,B,A).
/// tolerance: squared Euclidean distance threshold in RGBA space (0 = exact match).
void fill_flood(
    uint8_t* pixels, int width, int height,
    int startX, int startY,
    uint8_t fillR, uint8_t fillG, uint8_t fillB, uint8_t fillA,
    int tolerance
);

/// Scanline flood fill for float32 RGBA buffers.
/// Pixels are stored row-major, 4 floats per pixel (R,G,B,A).
/// tolerance: Euclidean per-channel threshold in [0,1] float space.
void fill_flood_f32(
    float* pixels, int width, int height,
    int startX, int startY,
    float fillR, float fillG, float fillB, float fillA,
    float tolerance
);
