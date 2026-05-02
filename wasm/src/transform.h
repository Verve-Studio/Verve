#pragma once
#include <cstdint>

/**
 * Affine transform with inverse-mapping.
 *
 * invMatrix[6] = [a, b, tx, c, d, ty]
 *   srcX = a * dstX + b * dstY + tx
 *   srcY = c * dstX + d * dstY + ty
 *
 * interp: 0 = nearest, 1 = bilinear, 2 = bicubic
 * Pixels mapped outside [0, srcW) × [0, srcH) write transparent (0,0,0,0).
 */
void transform_affine(
    const uint8_t* src, int srcW, int srcH,
    uint8_t* dst, int dstW, int dstH,
    const float* invMatrix,
    int interp
);

/**
 * Perspective transform with inverse-mapping via 3×3 homography.
 *
 * invH[9] = row-major 3×3 homography (inverse)
 *   [u]   [h0 h1 h2] [dstX]
 *   [v] ~ [h3 h4 h5] [dstY]
 *   [w]   [h6 h7 h8] [  1 ]
 *   srcX = u/w, srcY = v/w
 *
 * interp: 0 = nearest, 1 = bilinear, 2 = bicubic
 */
void transform_perspective(
    const uint8_t* src, int srcW, int srcH,
    uint8_t* dst, int dstW, int dstH,
    const float* invH,
    int interp
);

/**
 * Rotate an RGBA image (4 bytes/pixel) by 90°CW, 180°, or 270°CW.
 * amount: 0 = 90°CW, 1 = 180°, 2 = 270°CW
 * dst must be pre-allocated: srcH*srcW*4 bytes for 90/270, srcW*srcH*4 for 180.
 */
void rotate_rgba(
    const uint8_t* src, int srcW, int srcH,
    uint8_t* dst,
    int amount
);

/**
 * Flip an RGBA image (4 bytes/pixel) horizontally or vertically. src → dst.
 * axis: 0 = horizontal, 1 = vertical
 * dst must be pre-allocated: w*h*4 bytes.
 */
void flip_rgba(
    const uint8_t* src, int w, int h,
    uint8_t* dst,
    int axis
);

/**
 * Rotate an indexed (1 byte/pixel) image by 90°CW, 180°, or 270°CW.
 * amount: 0 = 90°CW, 1 = 180°, 2 = 270°CW
 * dst must be pre-allocated: srcH*srcW bytes for 90/270, srcW*srcH bytes for 180.
 */
void rotate_indexed(
    const uint8_t* src, int srcW, int srcH,
    uint8_t* dst,
    int amount
);

/**
 * Flip an indexed (1 byte/pixel) image horizontally or vertically. src → dst.
 * axis: 0 = horizontal, 1 = vertical
 * dst must be pre-allocated: w*h bytes.
 */
void flip_indexed(
    const uint8_t* src, int w, int h,
    uint8_t* dst,
    int axis
);
