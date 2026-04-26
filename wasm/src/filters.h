#pragma once
#include <cstdint>

/// Generic 2-D convolution.  src and dst must be separate buffers of size width*height*4.
/// kernel is a row-major float array of size kernelSize*kernelSize (must be odd).
/// Border pixels use clamp-to-edge.
void filters_convolve(
    const uint8_t* src, uint8_t* dst,
    int width, int height,
    const float* kernel, int kernelSize
);

/// Separable Gaussian blur applied in-place.
/// radius controls kernel half-size; sigma = radius / 3.
void filters_gaussian_blur(
    uint8_t* pixels, int width, int height, int radius
);

/// Single-pass box blur applied in-place.
/// radius controls the box half-size (kernel width = 2*radius+1).
void filters_box_blur(
    uint8_t* pixels, int width, int height, int radius
);

/// Radial blur applied in-place.
/// mode: 0 = Spin, 1 = Zoom.
/// amount: 1–100.
/// centerX/centerY: blur origin as fractions of canvas dimensions (0.0–1.0).
/// quality: 0 = Draft (8 samples), 1 = Good (16 samples), 2 = Best (32 samples).
void filters_radial_blur(
    uint8_t* pixels, int width, int height,
    int mode, int amount,
    float centerX, float centerY,
    int quality
);

/// 3×3 sharpening convolution (center=5, cardinal=-1, corners=0) applied in-place.
void filters_sharpen(
    uint8_t* pixels, int width, int height
);

/// 3×3 stronger sharpening convolution (center=9, all neighbors=-1) applied in-place.
void filters_sharpen_more(
    uint8_t* pixels, int width, int height
);

/// Unsharp Mask applied in-place.
/// amount:    1–500 (percentage; divide by 100.0f for multiplier).
/// radius:    1–64  (Gaussian blur radius).
/// threshold: 0–255 (minimum luminance difference to trigger sharpening).
void filters_unsharp_mask(
    uint8_t* pixels, int width, int height,
    int amount, int radius, int threshold
);

/// Smart Sharpen applied in-place.
/// amount:      1–500 (percentage).
/// radius:      1–64  (used for Gaussian mode only).
/// reduceNoise: 0–100 (percentage; 0 = no noise reduction).
/// remove:      0 = Gaussian Blur mode, 1 = Lens Blur (Laplacian) mode.
void filters_smart_sharpen(
    uint8_t* pixels, int width, int height,
    int amount, int radius, int reduceNoise, int remove
);

/// Add Noise applied in-place.
/// amount:        1–400 (%; 100 → ±127 delta before clamp).
/// distribution:  0 = Uniform, 1 = Gaussian approximation (average of 4 uniform samples).
/// monochromatic: 0 = independent RGB deltas, 1 = single delta for all RGB channels.
/// seed:          LCG initial state.
void filters_add_noise(
    uint8_t* pixels, int width, int height,
    int amount, int distribution, int monochromatic, uint32_t seed
);

/// Film Grain applied in-place.
/// grainSize:  1–100. At >1 the noise field is box-blurred before being added.
/// intensity:  1–200 (%; 100 → full ±127 grain amplitude).
/// roughness:  0–100. 0 = grain strongest in shadows; 100 = uniform amplitude.
/// seed:       LCG initial state.
void filters_film_grain(
    uint8_t* pixels, int width, int height,
    int grainSize, int intensity, int roughness, uint32_t seed
);

/// Lens Blur applied in-place (polygonal aperture convolution).
/// radius:         1–100 (px). Kernel size = 2*radius+1.
/// bladeCount:     3–8. Number of aperture polygon sides.
/// bladeCurvature: 0–100. 0 = straight polygon edges; 100 = perfect circle.
/// rotation:       0–360 (°). Rotates the aperture polygon.
void filters_lens_blur(
    uint8_t* pixels, int width, int height,
    int radius, int bladeCount, int bladeCurvature, int rotation
);

/// Clouds applied in-place (fractional value noise composited over existing pixels).
/// scale:     1–200. Larger values = larger cloud features.
/// opacity:   1–100 (%). 100 = fully replaces existing pixels in affected area.
/// colorMode: 0 = grayscale, 1 = use foreground/background color gradient.
/// fgR/G/B:   Foreground colour (used when colorMode == 1).
/// bgR/G/B:   Background colour (used when colorMode == 1).
/// seed:      0–9999. Same seed always produces the same noise pattern.
void filters_clouds(
    uint8_t* pixels, int width, int height,
    int scale, int opacity, int colorMode,
    uint8_t fgR, uint8_t fgG, uint8_t fgB,
    uint8_t bgR, uint8_t bgG, uint8_t bgB,
    uint32_t seed
);

/// Motion blur applied in-place.
/// Computes a box-average along a straight line at the given angle.
/// angleDeg: 0–360 (0 = horizontal right, increases clockwise).
/// distance: kernel length in samples (1–999); minimum 2 to have effect.
void filters_motion_blur(
    uint8_t* pixels, int width, int height,
    float angleDeg, int distance
);
