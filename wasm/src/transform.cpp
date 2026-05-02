#include "transform.h"
#include <cmath>
#include <algorithm>

namespace {

// ─── Sampling helpers ─────────────────────────────────────────────────────────

struct RGBA { float r, g, b, a; };

inline RGBA sample_nearest(const uint8_t* src, int srcW, int srcH, float su, float sv) {
    int u = static_cast<int>(su + 0.5f);
    int v = static_cast<int>(sv + 0.5f);
    if (u < 0 || u >= srcW || v < 0 || v >= srcH) return {0.f, 0.f, 0.f, 0.f};
    const uint8_t* p = src + (static_cast<std::ptrdiff_t>(v) * srcW + u) * 4;
    return { static_cast<float>(p[0]), static_cast<float>(p[1]),
             static_cast<float>(p[2]), static_cast<float>(p[3]) };
}

inline RGBA sample_bilinear(const uint8_t* src, int srcW, int srcH, float su, float sv) {
    float x = su - 0.5f;
    float y = sv - 0.5f;
    int x0 = static_cast<int>(std::floor(x));
    int y0 = static_cast<int>(std::floor(y));
    int x1 = x0 + 1, y1 = y0 + 1;
    float fx = x - static_cast<float>(x0);
    float fy = y - static_cast<float>(y0);

    auto clamp = [&](int px, int py) -> RGBA {
        px = std::max(0, std::min(srcW - 1, px));
        py = std::max(0, std::min(srcH - 1, py));
        const uint8_t* p = src + (static_cast<std::ptrdiff_t>(py) * srcW + px) * 4;
        return { static_cast<float>(p[0]), static_cast<float>(p[1]),
                 static_cast<float>(p[2]), static_cast<float>(p[3]) };
    };

    if (x1 <= 0 || x0 >= srcW || y1 <= 0 || y0 >= srcH) return {0.f, 0.f, 0.f, 0.f};

    RGBA c00 = clamp(x0, y0), c10 = clamp(x1, y0);
    RGBA c01 = clamp(x0, y1), c11 = clamp(x1, y1);

    auto lerp = [](float a, float b, float t) { return a + (b - a) * t; };
    return {
        lerp(lerp(c00.r, c10.r, fx), lerp(c01.r, c11.r, fx), fy),
        lerp(lerp(c00.g, c10.g, fx), lerp(c01.g, c11.g, fx), fy),
        lerp(lerp(c00.b, c10.b, fx), lerp(c01.b, c11.b, fx), fy),
        lerp(lerp(c00.a, c10.a, fx), lerp(c01.a, c11.a, fx), fy),
    };
}

inline float cubic_w(float t) {
    t = std::abs(t);
    if (t < 1.f) return 1.5f*t*t*t - 2.5f*t*t + 1.f;
    if (t < 2.f) return -0.5f*t*t*t + 2.5f*t*t - 4.f*t + 2.f;
    return 0.f;
}

inline RGBA sample_bicubic(const uint8_t* src, int srcW, int srcH, float su, float sv) {
    float x = su - 0.5f, y = sv - 0.5f;
    int x0 = static_cast<int>(std::floor(x));
    int y0 = static_cast<int>(std::floor(y));
    float fx = x - static_cast<float>(x0);
    float fy = y - static_cast<float>(y0);

    RGBA result = {0.f, 0.f, 0.f, 0.f};
    for (int dy = -1; dy <= 2; dy++) {
        float wy = cubic_w(fy - static_cast<float>(dy));
        for (int dx = -1; dx <= 2; dx++) {
            float w = wy * cubic_w(fx - static_cast<float>(dx));
            int px = std::max(0, std::min(srcW - 1, x0 + dx));
            int py = std::max(0, std::min(srcH - 1, y0 + dy));
            const uint8_t* p = src + (static_cast<std::ptrdiff_t>(py) * srcW + px) * 4;
            result.r += w * static_cast<float>(p[0]);
            result.g += w * static_cast<float>(p[1]);
            result.b += w * static_cast<float>(p[2]);
            result.a += w * static_cast<float>(p[3]);
        }
    }
    return result;
}

inline RGBA sample(const uint8_t* src, int srcW, int srcH, float su, float sv, int interp) {
    if (su < -0.5f || su >= static_cast<float>(srcW) + 0.5f ||
        sv < -0.5f || sv >= static_cast<float>(srcH) + 0.5f)
        return {0.f, 0.f, 0.f, 0.f};
    if (interp == 0) return sample_nearest(src, srcW, srcH, su, sv);
    if (interp == 1) return sample_bilinear(src, srcW, srcH, su, sv);
    return sample_bicubic(src, srcW, srcH, su, sv);
}

inline void write_rgba(uint8_t* dst, int dstW, int x, int y, RGBA c) {
    uint8_t* p = dst + (static_cast<std::ptrdiff_t>(y) * dstW + x) * 4;
    p[0] = static_cast<uint8_t>(std::max(0.f, std::min(255.f, c.r)));
    p[1] = static_cast<uint8_t>(std::max(0.f, std::min(255.f, c.g)));
    p[2] = static_cast<uint8_t>(std::max(0.f, std::min(255.f, c.b)));
    p[3] = static_cast<uint8_t>(std::max(0.f, std::min(255.f, c.a)));
}

} // namespace

void transform_affine(
    const uint8_t* src, int srcW, int srcH,
    uint8_t* dst, int dstW, int dstH,
    const float* invMatrix,
    int interp
) {
    const float a = invMatrix[0], b = invMatrix[1], tx = invMatrix[2];
    const float c = invMatrix[3], d = invMatrix[4], ty = invMatrix[5];

    for (int y = 0; y < dstH; y++) {
        for (int x = 0; x < dstW; x++) {
            const float fx = static_cast<float>(x);
            const float fy = static_cast<float>(y);
            write_rgba(dst, dstW, x, y,
                sample(src, srcW, srcH, a*fx + b*fy + tx, c*fx + d*fy + ty, interp));
        }
    }
}

void transform_perspective(
    const uint8_t* src, int srcW, int srcH,
    uint8_t* dst, int dstW, int dstH,
    const float* invH,
    int interp
) {
    for (int y = 0; y < dstH; y++) {
        for (int x = 0; x < dstW; x++) {
            const float fx = static_cast<float>(x);
            const float fy = static_cast<float>(y);
            const float u = invH[0]*fx + invH[1]*fy + invH[2];
            const float v = invH[3]*fx + invH[4]*fy + invH[5];
            const float w = invH[6]*fx + invH[7]*fy + invH[8];
            if (std::abs(w) < 1e-9f) {
                uint8_t* p = dst + (static_cast<std::ptrdiff_t>(y) * dstW + x) * 4;
                p[0] = p[1] = p[2] = p[3] = 0;
                continue;
            }
            write_rgba(dst, dstW, x, y, sample(src, srcW, srcH, u/w, v/w, interp));
        }
    }
}

// ─── Rotate RGBA ──────────────────────────────────────────────────────────────

void rotate_rgba(const uint8_t* src, int srcW, int srcH, uint8_t* dst, int amount) {
    // dstW/dstH depend on amount
    const int dstW = (amount == 1) ? srcW : srcH;
    const int dstH = (amount == 1) ? srcH : srcW;
    for (int dy = 0; dy < dstH; dy++) {
        for (int dx = 0; dx < dstW; dx++) {
            int sx, sy;
            if (amount == 0) {        // 90° CW
                sx = dy;
                sy = srcH - 1 - dx;
            } else if (amount == 1) { // 180°
                sx = srcW - 1 - dx;
                sy = srcH - 1 - dy;
            } else {                  // 270° CW
                sx = srcW - 1 - dy;
                sy = dx;
            }
            const uint8_t* s = src + (sy * srcW + sx) * 4;
            uint8_t*       d = dst + (dy * dstW + dx) * 4;
            d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; d[3] = s[3];
        }
    }
}

// ─── Flip RGBA ────────────────────────────────────────────────────────────────

void flip_rgba(const uint8_t* src, int w, int h, uint8_t* dst, int axis) {
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            int sx = (axis == 0) ? (w - 1 - x) : x;
            int sy = (axis == 1) ? (h - 1 - y) : y;
            const uint8_t* s = src + (sy * w + sx) * 4;
            uint8_t*       d = dst + ( y * w +  x) * 4;
            d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; d[3] = s[3];
        }
    }
}

// ─── Rotate indexed ───────────────────────────────────────────────────────────

void rotate_indexed(const uint8_t* src, int srcW, int srcH, uint8_t* dst, int amount) {
    const int dstW = (amount == 1) ? srcW : srcH;
    const int dstH = (amount == 1) ? srcH : srcW;
    for (int dy = 0; dy < dstH; dy++) {
        for (int dx = 0; dx < dstW; dx++) {
            int sx, sy;
            if (amount == 0) {        // 90° CW
                sx = dy;
                sy = srcH - 1 - dx;
            } else if (amount == 1) { // 180°
                sx = srcW - 1 - dx;
                sy = srcH - 1 - dy;
            } else {                  // 270° CW
                sx = srcW - 1 - dy;
                sy = dx;
            }
            dst[dy * dstW + dx] = src[sy * srcW + sx];
        }
    }
}

// ─── Flip indexed ─────────────────────────────────────────────────────────────

void flip_indexed(const uint8_t* src, int w, int h, uint8_t* dst, int axis) {
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            int sx = (axis == 0) ? (w - 1 - x) : x;
            int sy = (axis == 1) ? (h - 1 - y) : y;
            dst[y * w + x] = src[sy * w + sx];
        }
    }
}
