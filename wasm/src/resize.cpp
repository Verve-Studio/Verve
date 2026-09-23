#include "resize.h"
#include <cstddef>
#include <algorithm>
#include <cmath>

// ─── Bilinear ─────────────────────────────────────────────────────────────────

void resize_bilinear(
    const uint8_t* src, int srcWidth, int srcHeight,
    uint8_t* dst, int dstWidth, int dstHeight
) {
    const float xScale = static_cast<float>(srcWidth)  / dstWidth;
    const float yScale = static_cast<float>(srcHeight) / dstHeight;

    for (int dy = 0; dy < dstHeight; ++dy) {
        // Map destination row centre to source space
        const float sy = (dy + 0.5f) * yScale - 0.5f;
        const int y0   = std::clamp(static_cast<int>(sy),     0, srcHeight - 1);
        const int y1   = std::clamp(static_cast<int>(sy) + 1, 0, srcHeight - 1);
        const float fy = sy - std::floor(sy);

        for (int dx = 0; dx < dstWidth; ++dx) {
            const float sx = (dx + 0.5f) * xScale - 0.5f;
            const int x0   = std::clamp(static_cast<int>(sx),     0, srcWidth - 1);
            const int x1   = std::clamp(static_cast<int>(sx) + 1, 0, srcWidth - 1);
            const float fx = sx - std::floor(sx);

            // Four neighbouring pixels
            const uint8_t* p00 = src + (static_cast<size_t>(y0) * srcWidth + x0) * 4;
            const uint8_t* p10 = src + (static_cast<size_t>(y0) * srcWidth + x1) * 4;
            const uint8_t* p01 = src + (static_cast<size_t>(y1) * srcWidth + x0) * 4;
            const uint8_t* p11 = src + (static_cast<size_t>(y1) * srcWidth + x1) * 4;

            uint8_t* out = dst + (static_cast<size_t>(dy) * dstWidth + dx) * 4;
            for (int c = 0; c < 4; ++c) {
                const float top    = p00[c] + fx * (p10[c] - p00[c]);
                const float bottom = p01[c] + fx * (p11[c] - p01[c]);
                out[c] = static_cast<uint8_t>(
                    std::clamp(static_cast<int>(top + fy * (bottom - top)), 0, 255));
            }
        }
    }
}

// ─── Nearest-neighbour ────────────────────────────────────────────────────────

void resize_nearest(
    const uint8_t* src, int srcWidth, int srcHeight,
    uint8_t* dst, int dstWidth, int dstHeight
) {
    const float xScale = static_cast<float>(srcWidth)  / dstWidth;
    const float yScale = static_cast<float>(srcHeight) / dstHeight;

    for (int dy = 0; dy < dstHeight; ++dy) {
        const int sy = std::clamp(static_cast<int>((dy + 0.5f) * yScale), 0, srcHeight - 1);
        for (int dx = 0; dx < dstWidth; ++dx) {
            const int sx = std::clamp(static_cast<int>((dx + 0.5f) * xScale), 0, srcWidth - 1);
            const uint8_t* srcPx = src + (static_cast<size_t>(sy) * srcWidth + sx) * 4;
            uint8_t*       dstPx = dst + (static_cast<size_t>(dy) * dstWidth + dx) * 4;
            dstPx[0] = srcPx[0];
            dstPx[1] = srcPx[1];
            dstPx[2] = srcPx[2];
            dstPx[3] = srcPx[3];
        }
    }
}
