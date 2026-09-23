#include "curves_histogram.h"
#include <cstddef>
#include <cstdlib>
#include <cstring>

float* computeCurvesHistogram(
    const uint8_t* inputPixelData, uint32_t width, uint32_t height,
    const uint8_t* selectionMask
) {
    const uint32_t histogramSize = 4 * 256; // 4 channels × 256 bins
    float* histogram = static_cast<float*>(std::malloc(histogramSize * sizeof(float)));
    if (!histogram) return nullptr;
    // Accumulate in double: a float accumulator stalls once a bin passes 2^24
    // (adding 1.0 no longer changes the value), which undercounts large flat
    // images. Converted to float only when writing the output below.
    double acc[histogramSize];
    std::memset(acc, 0, sizeof(acc));

    const size_t pixelCount = static_cast<size_t>(width) * height;
    
    for (size_t i = 0; i < pixelCount; ++i) {
        const size_t srcIdx = i * 4; // RGBA
        const uint8_t r = inputPixelData[srcIdx];
        const uint8_t g = inputPixelData[srcIdx + 1];
        const uint8_t b = inputPixelData[srcIdx + 2];
        const uint8_t a = inputPixelData[srcIdx + 3];

        // Skip fully transparent pixels
        if (a == 0) continue;

        // Calculate effective weight
        double weight = static_cast<double>(a) / 255.0;
        if (selectionMask) {
            const uint8_t maskValue = selectionMask[i];
            weight *= static_cast<double>(maskValue) / 255.0;
        }

        // Indices into the histogram array
        uint32_t rgbBase = 0;
        uint32_t redBase = 256;
        uint32_t greenBase = 512;
        uint32_t blueBase = 768;

        // Increment histograms
        acc[rgbBase + r] += weight;
        acc[rgbBase + g] += weight;
        acc[rgbBase + b] += weight;
        acc[redBase + r] += weight;
        acc[greenBase + g] += weight;
        acc[blueBase + b] += weight;
    }

    for (uint32_t i = 0; i < histogramSize; ++i) {
        histogram[i] = static_cast<float>(acc[i]);
    }

    return histogram;
}
