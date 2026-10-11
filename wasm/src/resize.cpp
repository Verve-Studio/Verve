#include "resize.h"
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdlib>
#include <cstring>

namespace {

/// Taps for one axis: for output pixel i, entries [start[i], start[i+1]) of
/// index (layer-local source index, -1 = outside the layer) and weight.
struct Taps {
    int* index = nullptr;
    float* weight = nullptr;
    int* start = nullptr;
    int maxSpan = 0;  ///< widest source window of any output pixel

    ~Taps() {
        std::free(index);
        std::free(weight);
        std::free(start);
    }
};

int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

/// Layer-local index of canvas position `s` (clamped to the old canvas),
/// or -1 when it falls outside the layer.
int localIndex(int s, int oldCanvas, int srcOffset, int srcSize) {
    const int local = clampi(s, 0, oldCanvas - 1) - srcOffset;
    return (local >= 0 && local < srcSize) ? local : -1;
}

bool buildTaps(Taps& t, int dstStart, int n, double scale, int oldCanvas,
               int srcOffset, int srcSize) {
    const double support = scale < 1.0 ? 1.0 / scale : 1.0;
    const int perPixel = static_cast<int>(std::ceil(support)) * 2 + 2;
    const size_t cap = static_cast<size_t>(n) * perPixel;
    t.index = static_cast<int*>(std::malloc(cap * sizeof(int)));
    t.weight = static_cast<float*>(std::malloc(cap * sizeof(float)));
    t.start = static_cast<int*>(std::malloc((static_cast<size_t>(n) + 1) * sizeof(int)));
    if (!t.index || !t.weight || !t.start) return false;

    int count = 0;
    for (int i = 0; i < n; ++i) {
        t.start[i] = count;
        const double center = (dstStart + i + 0.5) / scale - 0.5;
        const int lo = static_cast<int>(std::floor(center - support)) + 1;
        const int hi = static_cast<int>(std::ceil(center + support)) - 1;
        const int first = count;
        double total = 0.0;
        int minIdx = 1 << 30, maxIdx = -1;
        for (int s = std::min(lo, hi); s <= std::max(lo, hi); ++s) {
            const double w = 1.0 - std::fabs(s - center) / support;
            if (w <= 0.0) continue;
            const int idx = localIndex(s, oldCanvas, srcOffset, srcSize);
            t.index[count] = idx;
            t.weight[count] = static_cast<float>(w);
            ++count;
            total += w;
            if (idx >= 0) {
                minIdx = std::min(minIdx, idx);
                maxIdx = std::max(maxIdx, idx);
            }
        }
        if (total == 0.0) {
            // Exactly on a sample: take the nearest one.
            const int idx = localIndex(static_cast<int>(std::lround(center)), oldCanvas, srcOffset, srcSize);
            t.index[count] = idx;
            t.weight[count] = 1.0f;
            ++count;
            total = 1.0;
            if (idx >= 0) minIdx = maxIdx = idx;
        }
        for (int k = first; k < count; ++k) t.weight[k] = static_cast<float>(t.weight[k] / total);
        if (maxIdx >= minIdx) t.maxSpan = std::max(t.maxSpan, maxIdx - minIdx + 1);
    }
    t.start[n] = count;
    return true;
}

/// Premultiplied, horizontally resampled row `row` of the source.
template <typename T>
void horizontalRow(const T* src, int srcW, int row, float toUnit, const Taps& tx, int dstW, float* out) {
    const T* line = src + static_cast<size_t>(row) * srcW * 4;
    for (int i = 0; i < dstW; ++i) {
        float r = 0, g = 0, b = 0, a = 0;
        for (int k = tx.start[i]; k < tx.start[i + 1]; ++k) {
            const int c = tx.index[k];
            if (c < 0) continue;
            const T* p = line + static_cast<size_t>(c) * 4;
            const float pa = static_cast<float>(p[3]) * toUnit;
            const float w = tx.weight[k] * pa;
            r += static_cast<float>(p[0]) * toUnit * w;
            g += static_cast<float>(p[1]) * toUnit * w;
            b += static_cast<float>(p[2]) * toUnit * w;
            a += tx.weight[k] * pa;
        }
        float* o = out + static_cast<size_t>(i) * 4;
        o[0] = r;
        o[1] = g;
        o[2] = b;
        o[3] = a;
    }
}

/// Tent resample of an RGBA layer. Rows of the horizontal pass are cached
/// in a ring sized to the widest vertical window, so memory stays at a few
/// output rows regardless of the layer size.
template <typename T, bool IsFloat>
int resizeFiltered(const T* src, int srcW, int srcH, int srcOx, int srcOy,
                   int oldW, int oldH, double sx, double sy,
                   T* dst, int dstX, int dstY, int dstW, int dstH) {
    Taps tx, ty;
    if (!buildTaps(tx, dstX, dstW, sx, oldW, srcOx, srcW)) return 1;
    if (!buildTaps(ty, dstY, dstH, sy, oldH, srcOy, srcH)) return 1;

    const int ring = std::max(1, ty.maxSpan) + 1;
    const size_t rowFloats = static_cast<size_t>(dstW) * 4;
    float* rows = static_cast<float*>(std::malloc(rowFloats * ring * sizeof(float)));
    int* tags = static_cast<int*>(std::malloc(static_cast<size_t>(ring) * sizeof(int)));
    if (!rows || !tags) {
        std::free(rows);
        std::free(tags);
        return 1;
    }
    for (int i = 0; i < ring; ++i) tags[i] = -1;

    const float toUnit = IsFloat ? 1.0f : 1.0f / 255.0f;
    for (int j = 0; j < dstH; ++j) {
        T* outRow = dst + static_cast<size_t>(j) * dstW * 4;
        // Make sure every source row this output row needs is resampled.
        for (int k = ty.start[j]; k < ty.start[j + 1]; ++k) {
            const int r = ty.index[k];
            if (r < 0) continue;
            const int slot = r % ring;
            if (tags[slot] != r) {
                horizontalRow(src, srcW, r, toUnit, tx, dstW, rows + rowFloats * slot);
                tags[slot] = r;
            }
        }
        for (int i = 0; i < dstW; ++i) {
            float r = 0, g = 0, b = 0, a = 0;
            for (int k = ty.start[j]; k < ty.start[j + 1]; ++k) {
                const int row = ty.index[k];
                if (row < 0) continue;
                const float w = ty.weight[k];
                const float* p = rows + rowFloats * (row % ring) + static_cast<size_t>(i) * 4;
                r += p[0] * w;
                g += p[1] * w;
                b += p[2] * w;
                a += p[3] * w;
            }
            T* o = outRow + static_cast<size_t>(i) * 4;
            if (a <= 0.0f) {
                o[0] = o[1] = o[2] = o[3] = 0;
                continue;
            }
            if constexpr (IsFloat) {
                // Scene-linear: no clamping, HDR values above 1 are kept.
                o[0] = r / a;
                o[1] = g / a;
                o[2] = b / a;
                o[3] = std::min(1.0f, a);
            } else {
                const float inv = 255.0f / a;
                o[0] = static_cast<T>(clampi(static_cast<int>(std::lround(r * inv)), 0, 255));
                o[1] = static_cast<T>(clampi(static_cast<int>(std::lround(g * inv)), 0, 255));
                o[2] = static_cast<T>(clampi(static_cast<int>(std::lround(b * inv)), 0, 255));
                o[3] = static_cast<T>(clampi(static_cast<int>(std::lround(a * 255.0f)), 0, 255));
            }
        }
    }
    std::free(rows);
    std::free(tags);
    return 0;
}

/// Nearest neighbour for any format: `channels` elements of T per pixel,
/// `transparent` fills pixels outside the layer.
template <typename T>
int resizeNearest(const T* src, int channels, int srcW, int srcH, int srcOx, int srcOy,
                  int oldW, int oldH, double sx, double sy,
                  T* dst, int dstX, int dstY, int dstW, int dstH, T transparent) {
    int* cols = static_cast<int*>(std::malloc(static_cast<size_t>(dstW) * sizeof(int)));
    if (!cols) return 1;
    for (int i = 0; i < dstW; ++i) {
        const int c = static_cast<int>(std::floor((dstX + i + 0.5) / sx));
        cols[i] = localIndex(c, oldW, srcOx, srcW);
    }
    for (int j = 0; j < dstH; ++j) {
        T* outRow = dst + static_cast<size_t>(j) * dstW * channels;
        const int r = localIndex(static_cast<int>(std::floor((dstY + j + 0.5) / sy)), oldH, srcOy, srcH);
        for (int i = 0; i < dstW; ++i) {
            T* o = outRow + static_cast<size_t>(i) * channels;
            if (r < 0 || cols[i] < 0) {
                for (int k = 0; k < channels; ++k) o[k] = transparent;
                continue;
            }
            const T* p = src + (static_cast<size_t>(r) * srcW + cols[i]) * channels;
            for (int k = 0; k < channels; ++k) o[k] = p[k];
        }
    }
    std::free(cols);
    return 0;
}

}  // namespace

int resize_layer(
    const void* src, int format, int srcW, int srcH, int srcOx, int srcOy,
    int oldCanvasW, int oldCanvasH, double scaleX, double scaleY,
    void* dst, int dstX, int dstY, int dstW, int dstH, int filter
) {
    if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0 || oldCanvasW <= 0 || oldCanvasH <= 0) return 0;
    if (format == RESIZE_INDEXED8) {
        return resizeNearest(static_cast<const uint8_t*>(src), 1, srcW, srcH, srcOx, srcOy,
                             oldCanvasW, oldCanvasH, scaleX, scaleY,
                             static_cast<uint8_t*>(dst), dstX, dstY, dstW, dstH, uint8_t{255});
    }
    if (format == RESIZE_RGBA32F) {
        const float* s = static_cast<const float*>(src);
        float* d = static_cast<float*>(dst);
        return filter == 1
            ? resizeNearest(s, 4, srcW, srcH, srcOx, srcOy, oldCanvasW, oldCanvasH, scaleX, scaleY, d, dstX, dstY, dstW, dstH, 0.0f)
            : resizeFiltered<float, true>(s, srcW, srcH, srcOx, srcOy, oldCanvasW, oldCanvasH, scaleX, scaleY, d, dstX, dstY, dstW, dstH);
    }
    const uint8_t* s = static_cast<const uint8_t*>(src);
    uint8_t* d = static_cast<uint8_t*>(dst);
    return filter == 1
        ? resizeNearest(s, 4, srcW, srcH, srcOx, srcOy, oldCanvasW, oldCanvasH, scaleX, scaleY, d, dstX, dstY, dstW, dstH, uint8_t{0})
        : resizeFiltered<uint8_t, false>(s, srcW, srcH, srcOx, srcOy, oldCanvasW, oldCanvasH, scaleX, scaleY, d, dstX, dstY, dstW, dstH);
}
