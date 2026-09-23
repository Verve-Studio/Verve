#include "quantize.h"
#include <cstddef>
#include <vector>
#include <algorithm>
#include <numeric>
#include <cstring>

struct PixelRGBA { uint8_t r, g, b, a; };

// ─── Bucket ───────────────────────────────────────────────────────────────────

struct Bucket {
    std::vector<PixelRGBA> pixels;

    // Returns the channel (0=R,1=G,2=B,3=A) with the largest range
    int dominantChannel() const {
        uint8_t rMin = 255, rMax = 0;
        uint8_t gMin = 255, gMax = 0;
        uint8_t bMin = 255, bMax = 0;
        uint8_t aMin = 255, aMax = 0;
        for (const auto& p : pixels) {
            if (p.r < rMin) rMin = p.r; if (p.r > rMax) rMax = p.r;
            if (p.g < gMin) gMin = p.g; if (p.g > gMax) gMax = p.g;
            if (p.b < bMin) bMin = p.b; if (p.b > bMax) bMax = p.b;
            if (p.a < aMin) aMin = p.a; if (p.a > aMax) aMax = p.a;
        }
        const int ranges[4] = { rMax - rMin, gMax - gMin, bMax - bMin, aMax - aMin };
        return static_cast<int>(std::max_element(ranges, ranges + 4) - ranges);
    }

    PixelRGBA average() const {
        uint64_t r = 0, g = 0, b = 0, a = 0;
        for (const auto& p : pixels) { r += p.r; g += p.g; b += p.b; a += p.a; }
        const uint64_t n = pixels.size();
        return { static_cast<uint8_t>(r / n), static_cast<uint8_t>(g / n),
                 static_cast<uint8_t>(b / n), static_cast<uint8_t>(a / n) };
    }
};

// Split bucket at median of its dominant channel; returns the upper half
static Bucket splitBucket(Bucket& bucket) {
    const int ch = bucket.dominantChannel();
    std::sort(bucket.pixels.begin(), bucket.pixels.end(),
        [ch](const PixelRGBA& a, const PixelRGBA& b) {
            const uint8_t* pa = reinterpret_cast<const uint8_t*>(&a);
            const uint8_t* pb = reinterpret_cast<const uint8_t*>(&b);
            return pa[ch] < pb[ch];
        });
    const std::size_t mid = bucket.pixels.size() / 2;
    Bucket upper;
    upper.pixels = std::vector<PixelRGBA>(
        bucket.pixels.begin() + mid, bucket.pixels.end());
    bucket.pixels.resize(mid);
    return upper;
}

// ─── Public API ───────────────────────────────────────────────────────────────

int quantize_median_cut(
    const uint8_t* pixels, int pixelCount,
    uint8_t* paletteOut, int maxColors
) {
    if (maxColors <= 0 || pixelCount <= 0) return 0;

    // Load all pixels into the initial bucket
    Bucket initial;
    initial.pixels.reserve(pixelCount);
    for (int i = 0; i < pixelCount; ++i) {
        const size_t idx = static_cast<size_t>(i) * 4;
        initial.pixels.push_back({ pixels[idx], pixels[idx+1], pixels[idx+2], pixels[idx+3] });
    }

    std::vector<Bucket> buckets;
    buckets.push_back(std::move(initial));

    // Repeatedly split the largest bucket until we reach maxColors
    while (static_cast<int>(buckets.size()) < maxColors) {
        // Find the bucket with the most pixels
        const auto it = std::max_element(buckets.begin(), buckets.end(),
            [](const Bucket& a, const Bucket& b) {
                return a.pixels.size() < b.pixels.size();
            });
        if (it->pixels.size() <= 1) break;

        Bucket upper = splitBucket(*it);
        buckets.push_back(std::move(upper));
    }

    // Write average color of each bucket to paletteOut
    const int count = static_cast<int>(buckets.size());
    for (int i = 0; i < count; ++i) {
        const PixelRGBA avg = buckets[i].average();
        paletteOut[i * 4]     = avg.r;
        paletteOut[i * 4 + 1] = avg.g;
        paletteOut[i * 4 + 2] = avg.b;
        paletteOut[i * 4 + 3] = avg.a;
    }
    return count;
}
