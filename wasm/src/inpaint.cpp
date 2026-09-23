#include "inpaint.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <queue>
#include <random>
#include <utility>
#include <vector>

static constexpr int   N_EM_ITERS_COARSE = 10;
static constexpr int   N_EM_ITERS_FINE   = 4;
static constexpr int   N_PM_ITERS        = 2;
static constexpr float ALPHA      = 0.5f;
static constexpr float SIGMA2     = 25.0f * 25.0f;
static constexpr int   COARSEST_MAX_DIM = 32;

struct Offset { int dx, dy; };

struct PyramidLevel {
    int width = 0;
    int height = 0;
    std::vector<uint8_t> pixels;
    std::vector<uint8_t> mask;
    std::vector<uint8_t> sourceMask;   // empty = unconstrained at this level
};

struct LevelBuffers {
    std::vector<uint8_t> isFill;
    std::vector<std::pair<int, int>> fillPixels;
    std::vector<std::pair<int, int>> sourcePixels;
    std::vector<int> fillIndex;
    std::vector<int> dist;
    std::vector<int> nearestSource;
};

static inline int clampI(int v, int lo, int hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

static float patchSSD(
    const uint8_t* img,
    int width, int height,
    int ax, int ay, int bx, int by,
    int hp
) {
    float ssd = 0.0f;
    int count = 0;
    for (int dy = -hp; dy <= hp; dy++) {
        const int ay2 = ay + dy, by2 = by + dy;
        if (ay2 < 0 || ay2 >= height || by2 < 0 || by2 >= height) continue;
        for (int dx = -hp; dx <= hp; dx++) {
            const int ax2 = ax + dx, bx2 = bx + dx;
            if (ax2 < 0 || ax2 >= width || bx2 < 0 || bx2 >= width) continue;
            const uint8_t* pa = img + (static_cast<size_t>(ay2) * width + ax2) * 4;
            const uint8_t* pb = img + (static_cast<size_t>(by2) * width + bx2) * 4;
            const float dr = static_cast<float>(pa[0]) - static_cast<float>(pb[0]);
            const float dg = static_cast<float>(pa[1]) - static_cast<float>(pb[1]);
            const float db = static_cast<float>(pa[2]) - static_cast<float>(pb[2]);
            ssd += dr * dr + dg * dg + db * db;
            ++count;
        }
    }
    return (count == 0) ? 1e30f : ssd / static_cast<float>(count);
}

static bool computeFillBBox(
    const std::vector<uint8_t>& mask,
    int width,
    int height,
    int& minX,
    int& minY,
    int& maxX,
    int& maxY
) {
    minX = width;
    minY = height;
    maxX = -1;
    maxY = -1;

    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            if (!mask[static_cast<size_t>(y) * width + x]) {
                continue;
            }
            minX = std::min(minX, x);
            minY = std::min(minY, y);
            maxX = std::max(maxX, x);
            maxY = std::max(maxY, y);
        }
    }

    return maxX >= minX && maxY >= minY;
}

static PyramidLevel downsampleLevel(const PyramidLevel& src) {
    PyramidLevel dst;
    dst.width = std::max(1, src.width / 2);
    dst.height = std::max(1, src.height / 2);
    dst.pixels.resize(static_cast<size_t>(dst.width) * dst.height * 4);
    dst.mask.resize(static_cast<size_t>(dst.width) * dst.height);

    for (int y = 0; y < dst.height; ++y) {
        for (int x = 0; x < dst.width; ++x) {
            int sum[4] = {0, 0, 0, 0};
            int count = 0;
            uint8_t m = 0;

            for (int oy = 0; oy < 2; ++oy) {
                const int sy = clampI(y * 2 + oy, 0, src.height - 1);
                for (int ox = 0; ox < 2; ++ox) {
                    const int sx = clampI(x * 2 + ox, 0, src.width - 1);
                    const size_t sIdx = static_cast<size_t>(sy) * src.width + sx;
                    const uint8_t* sp = src.pixels.data() + sIdx * 4;
                    sum[0] += sp[0];
                    sum[1] += sp[1];
                    sum[2] += sp[2];
                    sum[3] += sp[3];
                    m = static_cast<uint8_t>(m | (src.mask[sIdx] ? 1 : 0));
                    ++count;
                }
            }

            const size_t dIdx = static_cast<size_t>(y) * dst.width + x;
            uint8_t* dp = dst.pixels.data() + dIdx * 4;
            dp[0] = static_cast<uint8_t>(sum[0] / count);
            dp[1] = static_cast<uint8_t>(sum[1] / count);
            dp[2] = static_cast<uint8_t>(sum[2] / count);
            dp[3] = static_cast<uint8_t>(sum[3] / count);
            dst.mask[dIdx] = m;
        }
    }

    if (!src.sourceMask.empty()) {
        dst.sourceMask.resize(static_cast<size_t>(dst.width) * dst.height, 0);
        for (int y = 0; y < dst.height; ++y) {
            for (int x = 0; x < dst.width; ++x) {
                uint8_t sm = 0;
                for (int oy = 0; oy < 2 && !sm; ++oy) {
                    const int sy = clampI(y * 2 + oy, 0, src.height - 1);
                    for (int ox = 0; ox < 2 && !sm; ++ox) {
                        const int sx = clampI(x * 2 + ox, 0, src.width - 1);
                        sm = static_cast<uint8_t>(sm | src.sourceMask[static_cast<size_t>(sy) * src.width + sx]);
                    }
                }
                dst.sourceMask[static_cast<size_t>(y) * dst.width + x] = sm;
            }
        }
    }

    return dst;
}

static void buildLevelBuffers(
    const std::vector<uint8_t>& mask,
    int width,
    int height,
    const uint8_t* sourceMask,
    LevelBuffers& buffers
) {
    const size_t n = static_cast<size_t>(width) * height;
    buffers.isFill.assign(n, 0);
    buffers.fillPixels.clear();
    buffers.sourcePixels.clear();
    buffers.fillIndex.assign(n, -1);
    buffers.dist.assign(n, std::numeric_limits<int>::max());
    buffers.nearestSource.assign(n, -1);

    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            const size_t idx = static_cast<size_t>(y) * width + x;
            if (mask[idx]) {
                buffers.isFill[idx] = 1;
                buffers.fillPixels.emplace_back(x, y);
            } else if (sourceMask == nullptr || sourceMask[idx] != 0) {
                buffers.sourcePixels.emplace_back(x, y);
            }
        }
    }

    if (buffers.fillPixels.empty() || buffers.sourcePixels.empty()) {
        return;
    }

    const int dx4[4] = {-1, 1, 0, 0};
    const int dy4[4] = {0, 0, -1, 1};

    std::queue<size_t> q;
    for (const auto& p : buffers.fillPixels) {
        const int x = p.first;
        const int y = p.second;
        const size_t idx = static_cast<size_t>(y) * width + x;
        for (int d = 0; d < 4; ++d) {
            const int nx = x + dx4[d];
            const int ny = y + dy4[d];
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                continue;
            }
            const size_t ni = static_cast<size_t>(ny) * width + nx;
            if (mask[ni]) {
                continue;
            }
            buffers.dist[idx] = 1;
            buffers.nearestSource[idx] = static_cast<int>(ni);
            q.push(idx);
            break;
        }
    }

    while (!q.empty()) {
        const size_t cur = q.front();
        q.pop();
        const int cx = static_cast<int>(cur % static_cast<size_t>(width));
        const int cy = static_cast<int>(cur / static_cast<size_t>(width));

        for (int d = 0; d < 4; ++d) {
            const int nx = cx + dx4[d];
            const int ny = cy + dy4[d];
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                continue;
            }
            const size_t ni = static_cast<size_t>(ny) * width + nx;
            if (!buffers.isFill[ni] || buffers.dist[ni] != std::numeric_limits<int>::max()) {
                continue;
            }
            buffers.dist[ni] = buffers.dist[cur] + 1;
            buffers.nearestSource[ni] = buffers.nearestSource[cur];
            q.push(ni);
        }
    }

    std::sort(
        buffers.fillPixels.begin(),
        buffers.fillPixels.end(),
        [&](const std::pair<int, int>& a, const std::pair<int, int>& b) {
            const int da = buffers.dist[static_cast<size_t>(a.second) * width + a.first];
            const int db = buffers.dist[static_cast<size_t>(b.second) * width + b.first];
            return da < db;
        }
    );

    for (int i = 0; i < static_cast<int>(buffers.fillPixels.size()); ++i) {
        const int x = buffers.fillPixels[i].first;
        const int y = buffers.fillPixels[i].second;
        buffers.fillIndex[static_cast<size_t>(y) * width + x] = i;
    }
}

void inpaint(
    const uint8_t* pixels, int width, int height,
    const uint8_t* mask, int patchSize,
    const uint8_t* sourceMask,
    uint8_t* out
) {
    const size_t n = static_cast<size_t>(width) * height;
    std::memcpy(out, pixels, n * 4);
    if (width <= 0 || height <= 0 || patchSize < 0) {
        return;
    }

    PyramidLevel level0;
    level0.width = width;
    level0.height = height;
    level0.pixels.assign(pixels, pixels + n * 4);
    level0.mask.assign(mask, mask + n);
    if (sourceMask != nullptr) {
        level0.sourceMask.assign(sourceMask, sourceMask + n);
    }

    std::vector<PyramidLevel> levels;
    levels.push_back(std::move(level0));

    while (true) {
        const PyramidLevel& cur = levels.back();
        int minX = 0;
        int minY = 0;
        int maxX = -1;
        int maxY = -1;
        const bool hasFill = computeFillBBox(cur.mask, cur.width, cur.height, minX, minY, maxX, maxY);
        if (!hasFill) {
            break;
        }

        const int fillW = maxX - minX + 1;
        const int fillH = maxY - minY + 1;
        const int fillMaxDim = std::max(fillW, fillH);
        if (fillMaxDim <= COARSEST_MAX_DIM || cur.width <= 2 || cur.height <= 2) {
            break;
        }

        levels.push_back(downsampleLevel(cur));
    }

    std::vector<Offset> prevNnf;
    std::vector<int> prevFillIndex;
    int prevW = 0;
    int prevH = 0;

    for (int levelIdx = static_cast<int>(levels.size()) - 1; levelIdx >= 0; --levelIdx) {
        PyramidLevel& level = levels[levelIdx];
        const int w = level.width;
        const int h = level.height;
        const size_t levelN = static_cast<size_t>(w) * h;

        LevelBuffers buffers;
        const uint8_t* levelSourceMask = level.sourceMask.empty() ? nullptr : level.sourceMask.data();
        buildLevelBuffers(level.mask, w, h, levelSourceMask, buffers);

        if (buffers.fillPixels.empty()) {
            prevNnf.clear();
            prevFillIndex.clear();
            prevW = w;
            prevH = h;
            continue;
        }
        if (buffers.sourcePixels.empty()) {
            prevNnf.clear();
            prevFillIndex = buffers.fillIndex;
            prevW = w;
            prevH = h;
            continue;
        }

        std::vector<uint8_t> working = level.pixels;
        const int fillCount = static_cast<int>(buffers.fillPixels.size());
        std::vector<Offset> nnf(static_cast<size_t>(fillCount), {0, 0});
        std::vector<float> nnfCost(static_cast<size_t>(fillCount), 1e30f);
        std::vector<uint8_t> hasNnf(static_cast<size_t>(fillCount), 0);

        bool seededAny = false;
        if (!prevNnf.empty() && !prevFillIndex.empty() && prevW > 0 && prevH > 0) {
            for (int i = 0; i < fillCount; ++i) {
                const int fx = buffers.fillPixels[i].first;
                const int fy = buffers.fillPixels[i].second;
                const int px = clampI(fx / 2, 0, prevW - 1);
                const int py = clampI(fy / 2, 0, prevH - 1);
                const int pIdx = prevFillIndex[static_cast<size_t>(py) * prevW + px];
                if (pIdx < 0 || pIdx >= static_cast<int>(prevNnf.size())) {
                    continue;
                }

                const int candSx = fx + prevNnf[pIdx].dx * 2;
                const int candSy = fy + prevNnf[pIdx].dy * 2;
                if (candSx < 0 || candSx >= w || candSy < 0 || candSy >= h) {
                    continue;
                }
                if (level.mask[static_cast<size_t>(candSy) * w + candSx]) {
                    continue;
                }
                if (!level.sourceMask.empty() && !level.sourceMask[static_cast<size_t>(candSy) * w + candSx]) {
                    continue;
                }

                nnf[i] = {candSx - fx, candSy - fy};
                hasNnf[i] = 1;
                seededAny = true;
            }
        }

        for (int i = 0; i < fillCount; ++i) {
            if (hasNnf[i]) {
                continue;
            }
            const int fx = buffers.fillPixels[i].first;
            const int fy = buffers.fillPixels[i].second;
            const size_t idx = static_cast<size_t>(fy) * w + fx;
            const int nearest = buffers.nearestSource[idx];
            if (nearest < 0) {
                continue;
            }
            const int sx = static_cast<int>(static_cast<size_t>(nearest) % static_cast<size_t>(w));
            const int sy = static_cast<int>(static_cast<size_t>(nearest) / static_cast<size_t>(w));
            nnf[i] = {sx - fx, sy - fy};
            hasNnf[i] = 1;
            seededAny = true;
        }

        if (!seededAny) {
            prevNnf.clear();
            prevFillIndex = buffers.fillIndex;
            prevW = w;
            prevH = h;
            continue;
        }

        for (int i = 0; i < fillCount; ++i) {
            if (!hasNnf[i]) {
                continue;
            }
            const int fx = buffers.fillPixels[i].first;
            const int fy = buffers.fillPixels[i].second;
            const int sx = clampI(fx + nnf[i].dx, 0, w - 1);
            const int sy = clampI(fy + nnf[i].dy, 0, h - 1);
            if (level.mask[static_cast<size_t>(sy) * w + sx]) {
                continue;
            }
            const uint8_t* srcPx = level.pixels.data() + (static_cast<size_t>(sy) * w + sx) * 4;
            uint8_t* dstPx = working.data() + (static_cast<size_t>(fy) * w + fx) * 4;
            dstPx[0] = srcPx[0];
            dstPx[1] = srcPx[1];
            dstPx[2] = srcPx[2];
            dstPx[3] = srcPx[3];
        }

        for (int i = 0; i < fillCount; ++i) {
            if (!hasNnf[i]) {
                continue;
            }
            const int fx = buffers.fillPixels[i].first;
            const int fy = buffers.fillPixels[i].second;
            const int sx = fx + nnf[i].dx;
            const int sy = fy + nnf[i].dy;
            if (sx < 0 || sx >= w || sy < 0 || sy >= h || level.mask[static_cast<size_t>(sy) * w + sx]) {
                nnfCost[i] = 1e30f;
                continue;
            }
            nnfCost[i] = patchSSD(working.data(), w, h, fx, fy, sx, sy, patchSize);
        }

        const int emIters = (levelIdx == static_cast<int>(levels.size()) - 1) ? N_EM_ITERS_COARSE : N_EM_ITERS_FINE;
        const int maxDim = std::max(w, h);
        const int dx4[4] = {-1, 1, 0, 0};
        const int dy4[4] = {0, 0, -1, 1};

        for (int emIter = 0; emIter < emIters; ++emIter) {
            std::mt19937 rng(static_cast<uint32_t>(
                (levelIdx + 1) * 73856093u ^
                (emIter + 1) * 19349663u ^
                static_cast<uint32_t>(std::chrono::steady_clock::now().time_since_epoch().count())
            ));

            for (int pmIter = 0; pmIter < N_PM_ITERS; ++pmIter) {
                const bool forward = (pmIter % 2 == 0);
                for (int step = 0; step < fillCount; ++step) {
                    const int i = forward ? step : (fillCount - 1 - step);
                    if (!hasNnf[i]) {
                        continue;
                    }

                    const int fx = buffers.fillPixels[i].first;
                    const int fy = buffers.fillPixels[i].second;

                    for (int d = 0; d < 4; ++d) {
                        const int nx = fx + dx4[d];
                        const int ny = fy + dy4[d];
                        if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
                            continue;
                        }

                        const size_t nIdx = static_cast<size_t>(ny) * w + nx;
                        int candSx = -1;
                        int candSy = -1;

                        const int neighborFill = buffers.fillIndex[nIdx];
                        if (neighborFill >= 0) {
                            if (!hasNnf[neighborFill]) {
                                continue;
                            }
                            candSx = fx + nnf[neighborFill].dx;
                            candSy = fy + nnf[neighborFill].dy;
                        } else {
                            candSx = nx;
                            candSy = ny;
                        }

                        if (candSx < 0 || candSx >= w || candSy < 0 || candSy >= h) {
                            continue;
                        }
                        if (level.mask[static_cast<size_t>(candSy) * w + candSx]) {
                            continue;
                        }
                        if (!level.sourceMask.empty() && !level.sourceMask[static_cast<size_t>(candSy) * w + candSx]) {
                            continue;
                        }

                        const float candCost = patchSSD(working.data(), w, h, fx, fy, candSx, candSy, patchSize);
                        if (candCost < nnfCost[i]) {
                            nnfCost[i] = candCost;
                            nnf[i] = {candSx - fx, candSy - fy};
                            hasNnf[i] = 1;
                        }
                    }

                    int baseSx = fx + nnf[i].dx;
                    int baseSy = fy + nnf[i].dy;
                    float radius = static_cast<float>(maxDim);

                    while (radius >= 1.0f) {
                        std::uniform_real_distribution<float> distR(-radius, radius);
                        const int candSx = clampI(static_cast<int>(baseSx + distR(rng)), 0, w - 1);
                        const int candSy = clampI(static_cast<int>(baseSy + distR(rng)), 0, h - 1);
                        if (!level.mask[static_cast<size_t>(candSy) * w + candSx] && (level.sourceMask.empty() || level.sourceMask[static_cast<size_t>(candSy) * w + candSx])) {
                            const float candCost = patchSSD(working.data(), w, h, fx, fy, candSx, candSy, patchSize);
                            if (candCost < nnfCost[i]) {
                                nnfCost[i] = candCost;
                                nnf[i] = {candSx - fx, candSy - fy};
                                baseSx = candSx;
                                baseSy = candSy;
                                hasNnf[i] = 1;
                            }
                        }
                        radius *= ALPHA;
                    }
                }
            }

            std::vector<float> accR(levelN, 0.0f);
            std::vector<float> accG(levelN, 0.0f);
            std::vector<float> accB(levelN, 0.0f);
            std::vector<float> accW(levelN, 0.0f);

            for (int i = 0; i < fillCount; ++i) {
                if (!hasNnf[i]) {
                    continue;
                }
                const int fx = buffers.fillPixels[i].first;
                const int fy = buffers.fillPixels[i].second;
                const int sx0 = fx + nnf[i].dx;
                const int sy0 = fy + nnf[i].dy;
                if (sx0 < 0 || sx0 >= w || sy0 < 0 || sy0 >= h || level.mask[static_cast<size_t>(sy0) * w + sx0]) {
                    continue;
                }

                const float weight = std::exp(-nnfCost[i] / SIGMA2);
                if (weight <= 0.0f) {
                    continue;
                }

                for (int dy = -patchSize; dy <= patchSize; ++dy) {
                    const int fy2 = fy + dy;
                    const int sy2 = sy0 + dy;
                    if (fy2 < 0 || fy2 >= h || sy2 < 0 || sy2 >= h) {
                        continue;
                    }

                    for (int dx = -patchSize; dx <= patchSize; ++dx) {
                        const int fx2 = fx + dx;
                        const int sx2 = sx0 + dx;
                        if (fx2 < 0 || fx2 >= w || sx2 < 0 || sx2 >= w) {
                            continue;
                        }

                        const size_t fi = static_cast<size_t>(fy2) * w + fx2;
                        if (!buffers.isFill[fi]) {
                            continue;
                        }
                        if (level.mask[static_cast<size_t>(sy2) * w + sx2]) {
                            continue;
                        }
                        if (!level.sourceMask.empty() && !level.sourceMask[static_cast<size_t>(sy2) * w + sx2]) {
                            continue;
                        }

                        const uint8_t* sp = working.data() + (static_cast<size_t>(sy2) * w + sx2) * 4;
                        accR[fi] += weight * static_cast<float>(sp[0]);
                        accG[fi] += weight * static_cast<float>(sp[1]);
                        accB[fi] += weight * static_cast<float>(sp[2]);
                        accW[fi] += weight;
                    }
                }
            }

            for (const auto& p : buffers.fillPixels) {
                const int fx = p.first;
                const int fy = p.second;
                const size_t idx = static_cast<size_t>(fy) * w + fx;
                if (accW[idx] <= 0.0f) {
                    continue;
                }

                const float invW = 1.0f / accW[idx];
                uint8_t* dp = working.data() + idx * 4;
                dp[0] = static_cast<uint8_t>(clampI(static_cast<int>(accR[idx] * invW + 0.5f), 0, 255));
                dp[1] = static_cast<uint8_t>(clampI(static_cast<int>(accG[idx] * invW + 0.5f), 0, 255));
                dp[2] = static_cast<uint8_t>(clampI(static_cast<int>(accB[idx] * invW + 0.5f), 0, 255));
                dp[3] = 255;
            }

            for (int i = 0; i < fillCount; ++i) {
                if (!hasNnf[i]) {
                    continue;
                }
                const int fx = buffers.fillPixels[i].first;
                const int fy = buffers.fillPixels[i].second;
                const int sx = fx + nnf[i].dx;
                const int sy = fy + nnf[i].dy;
                if (sx < 0 || sx >= w || sy < 0 || sy >= h || level.mask[static_cast<size_t>(sy) * w + sx]) {
                    nnfCost[i] = 1e30f;
                    continue;
                }
                nnfCost[i] = patchSSD(working.data(), w, h, fx, fy, sx, sy, patchSize);
            }
        }

        level.pixels.swap(working);

        prevNnf = nnf;
        prevFillIndex = buffers.fillIndex;
        prevW = w;
        prevH = h;

        if (levelIdx > 0) {
            PyramidLevel& finer = levels[levelIdx - 1];
            for (int y = 0; y < finer.height; ++y) {
                const int cy = clampI(y / 2, 0, h - 1);
                for (int x = 0; x < finer.width; ++x) {
                    const size_t fi = static_cast<size_t>(y) * finer.width + x;
                    if (!finer.mask[fi]) {
                        continue;
                    }
                    const int cx = clampI(x / 2, 0, w - 1);
                    const uint8_t* sp = level.pixels.data() + (static_cast<size_t>(cy) * w + cx) * 4;
                    uint8_t* dp = finer.pixels.data() + fi * 4;
                    dp[0] = sp[0];
                    dp[1] = sp[1];
                    dp[2] = sp[2];
                    dp[3] = sp[3];
                }
            }
        }
    }

    std::memcpy(out, levels[0].pixels.data(), n * 4);
}
