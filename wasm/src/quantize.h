#pragma once
#include <cstdint>

/// Palette quantization (variance-driven median cut + weighted k-means).
/// pixels: RGBA row-major buffer, pixelCount = width * height.
/// paletteOut: output buffer of size maxColors * 4 (RGBA, opaque).
/// Transparent pixels (alpha < 128) are ignored unless nothing is opaque.
/// Returns exactly maxColors entries when the image has at least that many
/// distinct colours, otherwise one entry per distinct colour; entries are
/// distinct and sorted by pixel coverage.
int quantize_median_cut(
    const uint8_t* pixels, int pixelCount,
    uint8_t* paletteOut, int maxColors
);
