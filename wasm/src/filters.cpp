#include "filters.h"
#include <vector>
#include <cmath>
#include <algorithm>

void filters_convolve(
    const uint8_t* src, uint8_t* dst,
    int width, int height,
    const float* kernel, int kernelSize
) {
    const int half = kernelSize / 2;

    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            float r = 0.f, g = 0.f, b = 0.f, a = 0.f;

            for (int ky = 0; ky < kernelSize; ++ky) {
                const int sy = std::clamp(y + ky - half, 0, height - 1);
                for (int kx = 0; kx < kernelSize; ++kx) {
                    const int sx  = std::clamp(x + kx - half, 0, width - 1);
                    const int idx = (sy * width + sx) * 4;
                    const float k = kernel[ky * kernelSize + kx];
                    r += src[idx]     * k;
                    g += src[idx + 1] * k;
                    b += src[idx + 2] * k;
                    a += src[idx + 3] * k;
                }
            }

            const int dstIdx = (y * width + x) * 4;
            dst[dstIdx]     = static_cast<uint8_t>(std::clamp((int)r, 0, 255));
            dst[dstIdx + 1] = static_cast<uint8_t>(std::clamp((int)g, 0, 255));
            dst[dstIdx + 2] = static_cast<uint8_t>(std::clamp((int)b, 0, 255));
            dst[dstIdx + 3] = static_cast<uint8_t>(std::clamp((int)a, 0, 255));
        }
    }
}

// ─── Triple box-blur approximation of Gaussian ────────────────────────────────
//
// Three sequential box blurs converge to a Gaussian (Central Limit Theorem).
// Each box blur uses a sliding-window sum — O(1) per pixel regardless of radius.
// This is 10-50× faster than the old separable kernel at large radii.

// Compute three box half-widths that together approximate a Gaussian with
// standard deviation sigma (formula by Ivan Kuckir).
static void boxesForGauss(float sigma, int& r0, int& r1, int& r2) {
    const int n = 3;
    float wIdeal = std::sqrt(12.f * sigma * sigma / n + 1.f);
    int wl = static_cast<int>(wIdeal);
    if (wl % 2 == 0) wl--;          // ensure odd
    const int wu = wl + 2;
    const float mIdeal =
        (12.f * sigma * sigma - n * wl * wl - 4.f * n * wl - 3.f * n)
        / (-4.f * wl - 4.f);
    const int m = static_cast<int>(std::round(mIdeal));
    const int rl = (wl - 1) / 2;
    const int ru = (wu - 1) / 2;
    r0 = (0 < m) ? rl : ru;
    r1 = (1 < m) ? rl : ru;
    r2 = (2 < m) ? rl : ru;
}

// Horizontal box blur: reads src, writes dst. All 4 RGBA channels in one pass.
static void boxBlurH(const uint8_t* src, uint8_t* dst,
                     int width, int height, int r)
{
    const int ksize = 2 * r + 1;
    for (int y = 0; y < height; ++y) {
        // Initialise the sliding-window sum for x = 0
        int s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        for (int i = 0; i < ksize; ++i) {
            const int xi  = std::clamp(i - r, 0, width - 1);
            const int idx = (y * width + xi) * 4;
            s0 += src[idx];
            s1 += src[idx + 1];
            s2 += src[idx + 2];
            s3 += src[idx + 3];
        }
        {
            const int di = y * width * 4;
            dst[di]     = static_cast<uint8_t>(s0 / ksize);
            dst[di + 1] = static_cast<uint8_t>(s1 / ksize);
            dst[di + 2] = static_cast<uint8_t>(s2 / ksize);
            dst[di + 3] = static_cast<uint8_t>(s3 / ksize);
        }
        for (int x = 1; x < width; ++x) {
            const int ax  = std::min(x + r,     width - 1);
            const int rx  = std::max(x - r - 1, 0);
            const int ai  = (y * width + ax) * 4;
            const int ri  = (y * width + rx) * 4;
            s0 += src[ai]     - src[ri];
            s1 += src[ai + 1] - src[ri + 1];
            s2 += src[ai + 2] - src[ri + 2];
            s3 += src[ai + 3] - src[ri + 3];
            const int di  = (y * width + x) * 4;
            dst[di]     = static_cast<uint8_t>(s0 / ksize);
            dst[di + 1] = static_cast<uint8_t>(s1 / ksize);
            dst[di + 2] = static_cast<uint8_t>(s2 / ksize);
            dst[di + 3] = static_cast<uint8_t>(s3 / ksize);
        }
    }
}

// Vertical box blur: reads src, writes dst. All 4 RGBA channels in one pass.
static void boxBlurV(const uint8_t* src, uint8_t* dst,
                     int width, int height, int r)
{
    const int ksize = 2 * r + 1;
    for (int x = 0; x < width; ++x) {
        int s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        for (int i = 0; i < ksize; ++i) {
            const int yi  = std::clamp(i - r, 0, height - 1);
            const int idx = (yi * width + x) * 4;
            s0 += src[idx];
            s1 += src[idx + 1];
            s2 += src[idx + 2];
            s3 += src[idx + 3];
        }
        {
            const int di = x * 4;
            dst[di]     = static_cast<uint8_t>(s0 / ksize);
            dst[di + 1] = static_cast<uint8_t>(s1 / ksize);
            dst[di + 2] = static_cast<uint8_t>(s2 / ksize);
            dst[di + 3] = static_cast<uint8_t>(s3 / ksize);
        }
        for (int y = 1; y < height; ++y) {
            const int ay  = std::min(y + r,      height - 1);
            const int ry  = std::max(y - r - 1,  0);
            const int ai  = (ay * width + x) * 4;
            const int ri  = (ry * width + x) * 4;
            s0 += src[ai]     - src[ri];
            s1 += src[ai + 1] - src[ri + 1];
            s2 += src[ai + 2] - src[ri + 2];
            s3 += src[ai + 3] - src[ri + 3];
            const int di  = (y * width + x) * 4;
            dst[di]     = static_cast<uint8_t>(s0 / ksize);
            dst[di + 1] = static_cast<uint8_t>(s1 / ksize);
            dst[di + 2] = static_cast<uint8_t>(s2 / ksize);
            dst[di + 3] = static_cast<uint8_t>(s3 / ksize);
        }
    }
}

void filters_gaussian_blur(
    uint8_t* pixels, int width, int height, int radius
) {
    if (radius <= 0) return;

    const float sigma = radius / 3.f + 1.f;
    int r0, r1, r2;
    boxesForGauss(sigma, r0, r1, r2);

    std::vector<uint8_t> tmp(static_cast<size_t>(width) * height * 4);

    // Each pass: H-blur pixels→tmp, V-blur tmp→pixels
    boxBlurH(pixels, tmp.data(), width, height, r0);
    boxBlurV(tmp.data(), pixels, width, height, r0);

    boxBlurH(pixels, tmp.data(), width, height, r1);
    boxBlurV(tmp.data(), pixels, width, height, r1);

    boxBlurH(pixels, tmp.data(), width, height, r2);
    boxBlurV(tmp.data(), pixels, width, height, r2);
}

void filters_box_blur(
    uint8_t* pixels, int width, int height, int radius
) {
    if (radius <= 0) return;

    std::vector<uint8_t> tmp(static_cast<size_t>(width) * height * 4);
    boxBlurH(pixels, tmp.data(), width, height, radius);
    boxBlurV(tmp.data(), pixels, width, height, radius);
}

// ─── Bilinear sample helper ────────────────────────────────────────────────────

static void sampleBilinear(
    const uint8_t* src, int width, int height,
    float sx, float sy,
    float& outR, float& outG, float& outB, float& outA)
{
    sx = std::clamp(sx, 0.f, (float)(width  - 1));
    sy = std::clamp(sy, 0.f, (float)(height - 1));

    const int x0 = (int)sx,        y0 = (int)sy;
    const int x1 = std::min(x0+1, width-1);
    const int y1 = std::min(y0+1, height-1);
    const float fx = sx - x0,      fy = sy - y0;

    auto px = [&](int x, int y) -> const uint8_t* {
        return src + (y * width + x) * 4;
    };

    const uint8_t* p00 = px(x0,y0); const uint8_t* p10 = px(x1,y0);
    const uint8_t* p01 = px(x0,y1); const uint8_t* p11 = px(x1,y1);

    float vals[4];
    for (int c = 0; c < 4; ++c) {
        float top    = p00[c] * (1-fx) + p10[c] * fx;
        float bottom = p01[c] * (1-fx) + p11[c] * fx;
        vals[c]      = top * (1-fy) + bottom * fy;
    }
    outR = vals[0]; outG = vals[1]; outB = vals[2]; outA = vals[3];
}

// ─── Radial Blur ──────────────────────────────────────────────────────────────

void filters_radial_blur(
    uint8_t* pixels, int width, int height,
    int mode, int amount,
    float centerX, float centerY,
    int quality
) {
    if (amount <= 0 || width <= 0 || height <= 0) return;

    const std::vector<uint8_t> src(pixels, pixels + (size_t)width * height * 4);

    const int numSamples = (quality == 0) ? 8 : (quality == 1) ? 16 : 32;

    const float cx = centerX * (float)(width  - 1);
    const float cy = centerY * (float)(height - 1);

    if (mode == 0) {
        const float spinAngle = (float)amount * (float)M_PI / 1800.f;

        for (int y = 0; y < height; ++y) {
            for (int x = 0; x < width; ++x) {
                const float dx = (float)x - cx;
                const float dy = (float)y - cy;
                const float dist = std::sqrt(dx*dx + dy*dy);

                const int dstIdx = (y * width + x) * 4;

                if (dist < 0.5f) {
                    pixels[dstIdx]   = src[dstIdx];
                    pixels[dstIdx+1] = src[dstIdx+1];
                    pixels[dstIdx+2] = src[dstIdx+2];
                    pixels[dstIdx+3] = src[dstIdx+3];
                    continue;
                }

                const float baseAngle = std::atan2(dy, dx);
                float accR = 0, accG = 0, accB = 0, accA = 0;

                for (int s = 0; s < numSamples; ++s) {
                    const float t     = (numSamples > 1)
                                          ? (float)s / (float)(numSamples - 1)
                                          : 0.5f;
                    const float theta = baseAngle - spinAngle * 0.5f + t * spinAngle;
                    const float sx_   = cx + dist * std::cos(theta);
                    const float sy_   = cy + dist * std::sin(theta);

                    float r, g, b, a;
                    sampleBilinear(src.data(), width, height, sx_, sy_, r, g, b, a);
                    accR += r; accG += g; accB += b; accA += a;
                }

                pixels[dstIdx]   = (uint8_t)std::clamp((int)(accR / numSamples), 0, 255);
                pixels[dstIdx+1] = (uint8_t)std::clamp((int)(accG / numSamples), 0, 255);
                pixels[dstIdx+2] = (uint8_t)std::clamp((int)(accB / numSamples), 0, 255);
                pixels[dstIdx+3] = (uint8_t)std::clamp((int)(accA / numSamples), 0, 255);
            }
        }

    } else {
        const float scale = (float)amount * 0.005f;

        for (int y = 0; y < height; ++y) {
            for (int x = 0; x < width; ++x) {
                const float dx = (float)x - cx;
                const float dy = (float)y - cy;

                const int dstIdx = (y * width + x) * 4;

                if (std::abs(dx) < 0.5f && std::abs(dy) < 0.5f) {
                    pixels[dstIdx]   = src[dstIdx];
                    pixels[dstIdx+1] = src[dstIdx+1];
                    pixels[dstIdx+2] = src[dstIdx+2];
                    pixels[dstIdx+3] = src[dstIdx+3];
                    continue;
                }

                float accR = 0, accG = 0, accB = 0, accA = 0;

                for (int s = 0; s < numSamples; ++s) {
                    const float t      = (numSamples > 1)
                                           ? (float)s / (float)(numSamples - 1)
                                           : 0.5f;
                    const float factor = 1.f - t * scale;
                    const float sx_    = cx + dx * factor;
                    const float sy_    = cy + dy * factor;

                    float r, g, b, a;
                    sampleBilinear(src.data(), width, height, sx_, sy_, r, g, b, a);
                    accR += r; accG += g; accB += b; accA += a;
                }

                pixels[dstIdx]   = (uint8_t)std::clamp((int)(accR / numSamples), 0, 255);
                pixels[dstIdx+1] = (uint8_t)std::clamp((int)(accG / numSamples), 0, 255);
                pixels[dstIdx+2] = (uint8_t)std::clamp((int)(accB / numSamples), 0, 255);
                pixels[dstIdx+3] = (uint8_t)std::clamp((int)(accA / numSamples), 0, 255);
            }
        }
    }
}

// ── filters_sharpen ───────────────────────────────────────────────────────────

void filters_sharpen(uint8_t* pixels, int width, int height) {
    const float kernel[9] = { 0,-1, 0, -1, 5,-1, 0,-1, 0 };
    std::vector<uint8_t> dst(static_cast<size_t>(width) * height * 4);
    filters_convolve(pixels, dst.data(), width, height, kernel, 3);
    std::copy(dst.begin(), dst.end(), pixels);
}

// ── filters_sharpen_more ──────────────────────────────────────────────────────

void filters_sharpen_more(uint8_t* pixels, int width, int height) {
    const float kernel[9] = { -1,-1,-1, -1, 9,-1, -1,-1,-1 };
    std::vector<uint8_t> dst(static_cast<size_t>(width) * height * 4);
    filters_convolve(pixels, dst.data(), width, height, kernel, 3);
    std::copy(dst.begin(), dst.end(), pixels);
}

// ── filters_unsharp_mask ──────────────────────────────────────────────────────

void filters_unsharp_mask(uint8_t* pixels, int width, int height,
                           int amount, int radius, int threshold) {
    const int n = width * height * 4;
    std::vector<uint8_t> original(pixels, pixels + n);
    std::vector<uint8_t> blurred(original);
    filters_gaussian_blur(blurred.data(), width, height, radius);
    const float scale = amount / 100.0f;
    for (int i = 0; i < width * height; ++i) {
        const int p = i * 4;
        const float dR = (float)original[p]   - (float)blurred[p];
        const float dG = (float)original[p+1] - (float)blurred[p+1];
        const float dB = (float)original[p+2] - (float)blurred[p+2];
        const float lumaDiff = std::abs(0.299f * dR + 0.587f * dG + 0.114f * dB);
        if (lumaDiff > (float)threshold) {
            pixels[p]   = (uint8_t)std::clamp((int)std::round((float)original[p]   + scale * dR), 0, 255);
            pixels[p+1] = (uint8_t)std::clamp((int)std::round((float)original[p+1] + scale * dG), 0, 255);
            pixels[p+2] = (uint8_t)std::clamp((int)std::round((float)original[p+2] + scale * dB), 0, 255);
        }
    }
}

// ── filters_smart_sharpen ─────────────────────────────────────────────────────

void filters_smart_sharpen(uint8_t* pixels, int width, int height,
                             int amount, int radius, int reduceNoise, int remove) {
    const int n = width * height * 4;
    std::vector<uint8_t> original(pixels, pixels + n);
    std::vector<uint8_t> sharpened(original);
    const float scale = amount / 100.0f;

    if (remove == 0) {
        // Gaussian Blur mode: USM without threshold
        std::vector<uint8_t> blurred(original);
        filters_gaussian_blur(blurred.data(), width, height, radius);
        for (int i = 0; i < width * height; ++i) {
            const int p = i * 4;
            for (int c = 0; c < 3; ++c) {
                const float diff = (float)original[p+c] - (float)blurred[p+c];
                sharpened[p+c] = (uint8_t)std::clamp((int)std::round((float)original[p+c] + scale * diff), 0, 255);
            }
            sharpened[p+3] = original[p+3];
        }
    } else {
        // Lens Blur mode: weighted sharpen kernel scaled by amount
        const float s = scale * 0.5f;
        const float sharpenKernel[9] = {
            -s,      -s,      -s,
            -s,  1 + 8*s,    -s,
            -s,      -s,      -s
        };
        for (int y = 0; y < height; ++y) {
            for (int x = 0; x < width; ++x) {
                float r=0, g=0, b=0;
                for (int ky = -1; ky <= 1; ++ky) {
                    for (int kx = -1; kx <= 1; ++kx) {
                        const int sy = std::clamp(y+ky, 0, height-1);
                        const int sx = std::clamp(x+kx, 0, width-1);
                        const int idx = (sy*width+sx)*4;
                        const float k = sharpenKernel[(ky+1)*3+(kx+1)];
                        r += (float)original[idx]   * k;
                        g += (float)original[idx+1] * k;
                        b += (float)original[idx+2] * k;
                    }
                }
                const int p = (y*width+x)*4;
                sharpened[p]   = (uint8_t)std::clamp((int)std::round(r), 0, 255);
                sharpened[p+1] = (uint8_t)std::clamp((int)std::round(g), 0, 255);
                sharpened[p+2] = (uint8_t)std::clamp((int)std::round(b), 0, 255);
                sharpened[p+3] = original[p+3];
            }
        }
    }

    // Reduce Noise post-processing
    if (reduceNoise > 0) {
        std::vector<uint8_t> smoothed(sharpened);
        std::vector<uint8_t> smoothed2(static_cast<size_t>(width) * height * 4);
        boxBlurH(sharpened.data(), smoothed.data(), width, height, 1);
        boxBlurV(smoothed.data(), smoothed2.data(), width, height, 1);
        const float blendFactor = (reduceNoise / 100.0f) * 0.5f;
        for (int i = 0; i < width * height; ++i) {
            const int p = i * 4;
            for (int c = 0; c < 3; ++c) {
                sharpened[p+c] = (uint8_t)std::clamp(
                    (int)std::round((float)sharpened[p+c] * (1.0f - blendFactor) + (float)smoothed2[p+c] * blendFactor),
                    0, 255
                );
            }
        }
    }

    std::copy(sharpened.begin(), sharpened.end(), pixels);
}

// ─── LCG helper (Numerical Recipes) ──────────────────────────────────────────
static inline uint32_t lcg_next(uint32_t state) {
    return 1664525u * state + 1013904223u;
}

// ─── Add Noise ────────────────────────────────────────────────────────────────

void filters_add_noise(
    uint8_t* pixels, int width, int height,
    int amount, int distribution, int monochromatic, uint32_t seed
) {
    if (amount <= 0 || width <= 0 || height <= 0) return;

    const int maxDelta = amount * 127 / 100;  // no cap; pixel clamp handles overflow
    const int range    = 2 * maxDelta + 1;    // [0, range)

    uint32_t state = seed;
    const int n    = width * height;

    for (int i = 0; i < n; ++i) {
        const int base = i * 4;

        auto sample_uniform = [&]() -> int {
            state = lcg_next(state);
            return (int)(state % (unsigned)range) - maxDelta;
        };

        auto sample_gaussian = [&]() -> int {
            int sum = 0;
            for (int k = 0; k < 4; ++k) {
                state = lcg_next(state);
                sum += (int)(state % (unsigned)(2 * maxDelta + 1));
            }
            return sum / 4 - maxDelta;
        };

        if (monochromatic) {
            const int delta = (distribution == 0) ? sample_uniform() : sample_gaussian();
            pixels[base]     = (uint8_t)std::clamp(pixels[base]     + delta, 0, 255);
            pixels[base + 1] = (uint8_t)std::clamp(pixels[base + 1] + delta, 0, 255);
            pixels[base + 2] = (uint8_t)std::clamp(pixels[base + 2] + delta, 0, 255);
        } else {
            for (int c = 0; c < 3; ++c) {
                const int delta = (distribution == 0) ? sample_uniform() : sample_gaussian();
                pixels[base + c] = (uint8_t)std::clamp(pixels[base + c] + delta, 0, 255);
            }
        }
        // pixels[base + 3] (alpha) is never modified.
    }
}

// ─── Film Grain ───────────────────────────────────────────────────────────────

void filters_film_grain(
    uint8_t* pixels, int width, int height,
    int grainSize, int intensity, int roughness, uint32_t seed
) {
    if (width <= 0 || height <= 0) return;

    const int n = width * height;

    // 1. Generate float noise field in [-1, 1] via Gaussian approx (4 uniform samples).
    std::vector<float> noise(n);
    uint32_t state = seed;
    for (int i = 0; i < n; ++i) {
        float sum = 0.f;
        for (int k = 0; k < 4; ++k) {
            state = lcg_next(state);
            sum += (float)(state & 0xFFFF) / 32767.5f;
        }
        noise[i] = sum / 4.f - 1.f;
    }

    // 2. Optionally blur the noise field to produce coarser grain clusters.
    const int blurRadius = (grainSize > 1) ? std::min(5, grainSize / 10) : 0;
    if (blurRadius > 0) {
        std::vector<uint8_t> noisePx(n * 4);
        for (int i = 0; i < n; ++i) {
            const uint8_t v = (uint8_t)std::clamp((int)((noise[i] + 1.f) * 127.5f), 0, 255);
            noisePx[i * 4]     = v;
            noisePx[i * 4 + 1] = v;
            noisePx[i * 4 + 2] = v;
            noisePx[i * 4 + 3] = v;
        }
        std::vector<uint8_t> tmp(n * 4);
        boxBlurH(noisePx.data(), tmp.data(), width, height, blurRadius);
        boxBlurV(tmp.data(), noisePx.data(), width, height, blurRadius);
        for (int i = 0; i < n; ++i) {
            noise[i] = (float)noisePx[i * 4] / 127.5f - 1.f;
        }
    }

    // 3. Apply grain to each pixel.
    const float intensityF = intensity / 100.f;
    const float roughnessF = roughness / 100.f;

    for (int i = 0; i < n; ++i) {
        const int base = i * 4;
        const float R  = pixels[base];
        const float G  = pixels[base + 1];
        const float B  = pixels[base + 2];

        const float luma   = (0.299f * R + 0.587f * G + 0.114f * B) / 255.f;
        const float weight = (1.f - roughnessF) * (1.f - luma) + roughnessF * 1.f;

        const float grainVal = noise[i] * 127.f * weight * intensityF;
        pixels[base]     = (uint8_t)std::clamp((int)(R + grainVal), 0, 255);
        pixels[base + 1] = (uint8_t)std::clamp((int)(G + grainVal), 0, 255);
        pixels[base + 2] = (uint8_t)std::clamp((int)(B + grainVal), 0, 255);
        // Alpha unchanged.
    }
}

// ─── Lens Blur ────────────────────────────────────────────────────────────────

void filters_lens_blur(
    uint8_t* pixels, int width, int height,
    int radius, int bladeCount, int bladeCurvature, int rotation
) {
    if (radius <= 0 || width <= 0 || height <= 0) return;

    const int ksize = 2 * radius + 1;
    std::vector<float> kernel(ksize * ksize, 0.f);

    const float PI          = 3.14159265358979323846f;
    const float bladeCurvF  = bladeCurvature / 100.f;
    const float rotRad      = rotation * PI / 180.f;
    const float bladeAngle  = (bladeCurvature < 100)
                                ? (2.f * PI / (float)bladeCount)
                                : 0.f;
    const float halfBlade   = bladeAngle / 2.f;
    const float polyInradius = (bladeCurvature < 100)
                                ? std::cos(PI / (float)bladeCount)
                                : 1.f;

    for (int ky = -radius; ky <= radius; ++ky) {
        for (int kx = -radius; kx <= radius; ++kx) {
            const float nx = (radius > 0) ? (float)kx / (float)radius : 0.f;
            const float ny = (radius > 0) ? (float)ky / (float)radius : 0.f;
            const float r  = std::sqrt(nx * nx + ny * ny);

            if (r > 1.5f) continue;

            const int idx = (ky + radius) * ksize + (kx + radius);

            if (bladeCurvature >= 100) {
                kernel[idx] = (r <= 1.f) ? 1.f : 0.f;
            } else {
                const float theta  = std::atan2(ny, nx) + rotRad;
                const float sector = std::fmod(theta + 20.f * PI, bladeAngle);
                const float polyR  = polyInradius / std::cos(sector - halfBlade);
                const float effectiveR = polyR * (1.f - bladeCurvF) + 1.f * bladeCurvF;
                kernel[idx] = (r <= effectiveR) ? 1.f : 0.f;
            }
        }
    }

    float kernelSum = 0.f;
    for (float v : kernel) kernelSum += v;
    if (kernelSum > 0.f) {
        for (float& v : kernel) v /= kernelSum;
    }

    const std::vector<uint8_t> src(pixels, pixels + (size_t)width * height * 4);

    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            float accR = 0.f, accG = 0.f, accB = 0.f, accA = 0.f;

            for (int ky = -radius; ky <= radius; ++ky) {
                for (int kx = -radius; kx <= radius; ++kx) {
                    const float w = kernel[(ky + radius) * ksize + (kx + radius)];
                    if (w == 0.f) continue;
                    float sR, sG, sB, sA;
                    sampleBilinear(src.data(), width, height,
                                   (float)(x + kx), (float)(y + ky),
                                   sR, sG, sB, sA);
                    accR += sR * w;
                    accG += sG * w;
                    accB += sB * w;
                    accA += sA * w;
                }
            }

            const int dstIdx = (y * width + x) * 4;
            pixels[dstIdx]     = (uint8_t)std::clamp((int)accR, 0, 255);
            pixels[dstIdx + 1] = (uint8_t)std::clamp((int)accG, 0, 255);
            pixels[dstIdx + 2] = (uint8_t)std::clamp((int)accB, 0, 255);
            pixels[dstIdx + 3] = (uint8_t)std::clamp((int)accA, 0, 255);
        }
    }
}

// ─── Clouds ───────────────────────────────────────────────────────────────────

void filters_clouds(
    uint8_t* pixels, int width, int height,
    int scale, int opacity, int colorMode,
    uint8_t fgR, uint8_t fgG, uint8_t fgB,
    uint8_t bgR, uint8_t bgG, uint8_t bgB,
    uint32_t seed
) {
    if (width <= 0 || height <= 0) return;

    static const int GRID = 256;

    // ── Permutation table from seed (Fisher-Yates) ────────────────────────
    uint8_t perm[GRID];
    for (int i = 0; i < GRID; ++i) perm[i] = (uint8_t)i;
    uint32_t state = seed ^ 0xDEADBEEFu;
    for (int i = GRID - 1; i > 0; --i) {
        state = lcg_next(state);
        int j = (int)(state % (uint32_t)(i + 1));
        uint8_t tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
    }

    // ── 8 gradient directions for 2D Perlin ───────────────────────────────
    static const float GX[8] = {  1.f, -1.f,  0.f,  0.f,  0.7071f, -0.7071f,  0.7071f, -0.7071f };
    static const float GY[8] = {  0.f,  0.f,  1.f, -1.f,  0.7071f,  0.7071f, -0.7071f, -0.7071f };

    auto hsample = [&](int ix, int iy) -> int {
        return perm[((int)perm[ix & (GRID - 1)] + (iy & (GRID - 1))) & (GRID - 1)] & 7;
    };

    auto fade = [](float t) -> float {
        return t * t * t * (t * (t * 6.f - 15.f) + 10.f);
    };

    // 2D gradient (Perlin) noise — returns approx [-0.7, 0.7]
    auto perlin = [&](float fx, float fy) -> float {
        const int   xi  = (int)std::floor(fx);
        const int   yi  = (int)std::floor(fy);
        const float rx0 = fx - (float)xi;
        const float ry0 = fy - (float)yi;
        const float u   = fade(rx0);
        const float v   = fade(ry0);

        const int h00 = hsample(xi,     yi    );
        const int h10 = hsample(xi + 1, yi    );
        const int h01 = hsample(xi,     yi + 1);
        const int h11 = hsample(xi + 1, yi + 1);

        const float d00 = GX[h00] * rx0         + GY[h00] * ry0;
        const float d10 = GX[h10] * (rx0 - 1.f) + GY[h10] * ry0;
        const float d01 = GX[h01] * rx0         + GY[h01] * (ry0 - 1.f);
        const float d11 = GX[h11] * (rx0 - 1.f) + GY[h11] * (ry0 - 1.f);

        const float ab = d00 + u * (d10 - d00);
        const float cd = d01 + u * (d11 - d01);
        return ab + v * (cd - ab);
    };

    // featureSize: pixels spanned by one base-octave cloud blob
    // scale=100 → 1 blob fills the canvas; scale=50 → ~2 blobs; scale=25 → ~4
    const float featureSize = std::max((float)scale / 100.f * (float)std::min(width, height), 1.f);
    // baseFreq: grid cells advanced per pixel at the base octave.
    // GRID cells should span featureSize pixels → each pixel advances GRID/featureSize cells.
    const float baseFreq    = (float)GRID / featureSize;
    const float opacityF    = (float)opacity / 100.f;

    for (int py = 0; py < height; ++py) {
        for (int px = 0; px < width; ++px) {
            float total  = 0.f;
            float maxAmp = 0.f;
            float freq   = baseFreq;
            float amp    = 1.f;
            for (int oct = 0; oct < 6; ++oct) {
                total  += perlin((float)px * freq, (float)py * freq) * amp;
                maxAmp += amp;
                amp    *= 0.5f;
                freq   *= 2.f;
            }
            // fBm Perlin sum is approx ±0.5; remap to [0,1] with slight contrast boost
            const float t = std::clamp(total / maxAmp * 1.4f + 0.5f, 0.f, 1.f);

            float cloudR, cloudG, cloudB;
            if (colorMode == 0) {
                cloudR = cloudG = cloudB = 255.f * t;
            } else {
                cloudR = (float)bgR + ((float)fgR - (float)bgR) * t;
                cloudG = (float)bgG + ((float)fgG - (float)bgG) * t;
                cloudB = (float)bgB + ((float)fgB - (float)bgB) * t;
            }

            const int base = (py * width + px) * 4;
            pixels[base]     = (uint8_t)std::clamp((int)(pixels[base]     + (cloudR - pixels[base])     * opacityF), 0, 255);
            pixels[base + 1] = (uint8_t)std::clamp((int)(pixels[base + 1] + (cloudG - pixels[base + 1]) * opacityF), 0, 255);
            pixels[base + 2] = (uint8_t)std::clamp((int)(pixels[base + 2] + (cloudB - pixels[base + 2]) * opacityF), 0, 255);
            // Alpha unchanged.
        }
    }
}

// Fast directional box average using per-ray prefix sums. O(width*height) regardless of distance.
// Computes dst[i] = mean of `distance` source pixels centered on i along direction angleDeg.
// src and dst must be separate arrays. Single-channel float, size = width*height.
static void directional_box_avg(
    const float* src, float* dst,
    int width, int height,
    float angleDeg, int distance
) {
    if (distance <= 1) {
        std::copy(src, src + (size_t)width * height, dst);
        return;
    }

    const float rad = angleDeg * 3.14159265358979f / 180.f;
    float cdx = std::cos(rad), cdy = std::sin(rad);

    // Symmetric kernel — flip so cdx >= 0
    if (cdx < 0.f) { cdx = -cdx; cdy = -cdy; }

    // Transpose so |cdx| >= |cdy| (primary axis = x, |slope| <= 1)
    const bool transposed = (std::abs(cdy) > cdx);
    float slope;
    if (!transposed) {
        slope = (cdx > 1e-6f) ? cdy / cdx : 0.f;
    } else {
        slope = (std::abs(cdy) > 1e-6f)
              ? (cdy < 0.f ? -1.f : 1.f) * cdx / std::abs(cdy)
              : 0.f;
    }

    const int W = transposed ? height : width;
    const int H = transposed ? width  : height;

    auto read = [&](int lx, int ly) -> float {
        const int px = transposed ? ly : lx;
        const int py = transposed ? lx : ly;
        return src[py * width + px];
    };
    auto write = [&](int lx, int ly, float v) {
        const int px = transposed ? ly : lx;
        const int py = transposed ? lx : ly;
        dst[py * width + px] = v;
    };

    const int half    = (distance - 1) / 2;
    const int ext_len = W + distance - 1;
    const int y_range = (int)(W * std::abs(slope)) + 2;
    const float inv_D = 1.f / (float)distance;

    std::vector<float> prefix(W + distance, 0.f);

    for (int ys = -y_range; ys < H + y_range; ++ys) {
        prefix[0] = 0.f;
        for (int i = 0; i < ext_len; ++i) {
            const int x_ext = i - half;
            const int x_c   = std::clamp(x_ext, 0, W - 1);
            const int y_ext = (int)std::round((float)ys + (float)x_ext * slope);
            const int y_c   = std::clamp(y_ext, 0, H - 1);
            prefix[i + 1]   = prefix[i] + read(x_c, y_c);
        }
        for (int x = 0; x < W; ++x) {
            const int y = (int)std::round((float)ys + (float)x * slope);
            if (y < 0 || y >= H) continue;
            write(x, y, (prefix[x + distance] - prefix[x]) * inv_D);
        }
    }
}

void filters_motion_blur(
    uint8_t* pixels, int width, int height,
    float angleDeg, int distance
) {
    if (distance <= 0 || width <= 0 || height <= 0) return;
    const int N = width * height;
    std::vector<float> src_ch(N), dst_ch(N);
    for (int c = 0; c < 4; ++c) {
        for (int i = 0; i < N; ++i) src_ch[i] = (float)pixels[i * 4 + c];
        directional_box_avg(src_ch.data(), dst_ch.data(), width, height, angleDeg, distance);
        for (int i = 0; i < N; ++i)
            pixels[i * 4 + c] = (uint8_t)std::clamp((int)dst_ch[i], 0, 255);
    }
}

void filters_remove_motion_blur(
    uint8_t* pixels, int width, int height,
    float angleDeg, int distance, int noiseReduction
) {
    if (width <= 0 || height <= 0 || distance <= 0) return;
    const int N = width * height;

    std::vector<float> inR(N), inG(N), inB(N);
    for (int i = 0; i < N; ++i) {
        inR[i] = (float)pixels[i * 4 + 0];
        inG[i] = (float)pixels[i * 4 + 1];
        inB[i] = (float)pixels[i * 4 + 2];
    }

    // More iterations produce stronger deblurring.
    // noiseReduction=0 → 25 iter (aggressive), noiseReduction=100 → 8 iter (gentle).
    const int   iterations = 8 + (int)((100 - noiseReduction) * 17 / 100);
    // Blend fraction: at high noiseReduction pull back toward original more.
    const float blendBack  = (noiseReduction / 100.f) * 0.35f;

    std::vector<float> estR = inR, estG = inG, estB = inB;
    std::vector<float> blurR(N), blurG(N), blurB(N);
    std::vector<float> ratR(N),  ratG(N),  ratB(N);
    std::vector<float> corrR(N), corrG(N), corrB(N);

    for (int iter = 0; iter < iterations; ++iter) {
        // Forward: blur current estimate with motion PSF
        directional_box_avg(estR.data(),  blurR.data(), width, height, angleDeg, distance);
        directional_box_avg(estG.data(),  blurG.data(), width, height, angleDeg, distance);
        directional_box_avg(estB.data(),  blurB.data(), width, height, angleDeg, distance);

        // Ratio: input / blurred — clamped to prevent wild updates
        for (int i = 0; i < N; ++i) {
            ratR[i] = std::clamp(inR[i] / std::max(blurR[i], 1.f), 0.f, 8.f);
            ratG[i] = std::clamp(inG[i] / std::max(blurG[i], 1.f), 0.f, 8.f);
            ratB[i] = std::clamp(inB[i] / std::max(blurB[i], 1.f), 0.f, 8.f);
        }

        // Back-projection (PSF is symmetric so same convolution)
        directional_box_avg(ratR.data(), corrR.data(), width, height, angleDeg, distance);
        directional_box_avg(ratG.data(), corrG.data(), width, height, angleDeg, distance);
        directional_box_avg(ratB.data(), corrB.data(), width, height, angleDeg, distance);

        // Multiplicative RL update
        for (int i = 0; i < N; ++i) {
            estR[i] = std::clamp(estR[i] * corrR[i], 0.f, 255.f);
            estG[i] = std::clamp(estG[i] * corrG[i], 0.f, 255.f);
            estB[i] = std::clamp(estB[i] * corrB[i], 0.f, 255.f);
        }
    }

    // Blend back toward input (noiseReduction damping)
    for (int i = 0; i < N; ++i) {
        pixels[i * 4 + 0] = (uint8_t)std::clamp((int)(estR[i] * (1.f - blendBack) + inR[i] * blendBack), 0, 255);
        pixels[i * 4 + 1] = (uint8_t)std::clamp((int)(estG[i] * (1.f - blendBack) + inG[i] * blendBack), 0, 255);
        pixels[i * 4 + 2] = (uint8_t)std::clamp((int)(estB[i] * (1.f - blendBack) + inB[i] * blendBack), 0, 255);
        // alpha unchanged
    }
}
