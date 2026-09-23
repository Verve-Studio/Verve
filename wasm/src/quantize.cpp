#include "quantize.h"
#include <cstddef>
#include <vector>
#include <algorithm>
#include <unordered_map>
#include <cstring>
#include <cmath>

// ─── Palette quantisation ─────────────────────────────────────────────────────
//
// Returns exactly `maxColors` entries whenever the image has at least that
// many distinct colours (fewer only when it doesn't):
//
//   1. Colour entries: every distinct opaque colour with its pixel count —
//      or, for images with more than MAX_EXACT distinct colours, a 5-bit
//      histogram whose bins carry exact channel sums (so centroids are true
//      averages, not bin centres). Transparent pixels (a < 128) are ignored;
//      averaging them in used to drag the palette towards black.
//   2. Variance-driven median cut: repeatedly split the box with the largest
//      weighted squared error, along its highest-variance axis, at the
//      weighted median. (The old cut split the most *populous* box — a large
//      flat area was cut into many identical buckets that deduplicated away,
//      so the palette came back far short of the requested count.)
//   3. Weighted k-means refinement; an emptied cluster is re-seeded with the
//      worst-fitting entry, so the count stays exact.
//
// Output colours are opaque (a = 255), sorted by pixel coverage.

namespace {

struct Entry {
    float r, g, b;
    double n;  // pixel count
};

constexpr size_t MAX_EXACT = 1u << 16;

// Perceptually weighted RGB distance (green matters most, blue least).
inline float dist2(float r0, float g0, float b0, float r1, float g1, float b1) {
    const float dr = r0 - r1, dg = g0 - g1, db = b0 - b1;
    return 2.f * dr * dr + 4.f * dg * dg + 3.f * db * db;
}

// Build colour entries from the opaque pixels (all pixels if none are).
std::vector<Entry> buildEntries(const uint8_t* px, size_t count) {
    bool anyOpaque = false;
    for (size_t i = 0; i < count; ++i) {
        if (px[i * 4 + 3] >= 128) { anyOpaque = true; break; }
    }
    const uint8_t minA = anyOpaque ? 128 : 0;

    // Exact distinct colours, abandoned once there are too many.
    std::unordered_map<uint32_t, double> exact;
    exact.reserve(4096);
    bool overflow = false;
    for (size_t i = 0; i < count; ++i) {
        const uint8_t* p = px + i * 4;
        if (p[3] < minA) continue;
        const uint32_t key = (uint32_t(p[0]) << 16) | (uint32_t(p[1]) << 8) | p[2];
        exact[key] += 1.0;
        if (exact.size() > MAX_EXACT) { overflow = true; break; }
    }
    std::vector<Entry> out;
    if (!overflow) {
        out.reserve(exact.size());
        for (const auto& kv : exact) {
            out.push_back({ float((kv.first >> 16) & 255), float((kv.first >> 8) & 255),
                            float(kv.first & 255), kv.second });
        }
        return out;
    }
    exact.clear();

    // 5-bit histogram with exact sums per bin.
    constexpr size_t BINS = 1u << 15;
    std::vector<double> n(BINS, 0.0), sr(BINS, 0.0), sg(BINS, 0.0), sb(BINS, 0.0);
    for (size_t i = 0; i < count; ++i) {
        const uint8_t* p = px + i * 4;
        if (p[3] < minA) continue;
        const size_t bin = (size_t(p[0] >> 3) << 10) | (size_t(p[1] >> 3) << 5) | (p[2] >> 3);
        n[bin] += 1.0;
        sr[bin] += p[0];
        sg[bin] += p[1];
        sb[bin] += p[2];
    }
    for (size_t i = 0; i < BINS; ++i) {
        if (n[i] > 0) {
            out.push_back({ float(sr[i] / n[i]), float(sg[i] / n[i]), float(sb[i] / n[i]), n[i] });
        }
    }
    return out;
}

struct Box {
    size_t lo, hi;   // entry range [lo, hi)
    double sse;      // weighted squared error around the box mean
    int axis;        // axis of largest weighted variance
};

Box makeBox(const std::vector<Entry>& e, size_t lo, size_t hi) {
    double w = 0, mr = 0, mg = 0, mb = 0;
    for (size_t i = lo; i < hi; ++i) {
        w += e[i].n; mr += e[i].r * e[i].n; mg += e[i].g * e[i].n; mb += e[i].b * e[i].n;
    }
    mr /= w; mg /= w; mb /= w;
    double vr = 0, vg = 0, vb = 0;
    for (size_t i = lo; i < hi; ++i) {
        const double dr = e[i].r - mr, dg = e[i].g - mg, db = e[i].b - mb;
        vr += e[i].n * dr * dr; vg += e[i].n * dg * dg; vb += e[i].n * db * db;
    }
    // Perceptual weights match dist2 so boxes split where the error is.
    const double wr = 2 * vr, wg = 4 * vg, wb = 3 * vb;
    const int axis = (wr >= wg && wr >= wb) ? 0 : (wg >= wb ? 1 : 2);
    return { lo, hi, wr + wg + wb, axis };
}

inline float channel(const Entry& e, int axis) {
    return axis == 0 ? e.r : axis == 1 ? e.g : e.b;
}

}  // namespace

int quantize_median_cut(
    const uint8_t* pixels, int pixelCount,
    uint8_t* paletteOut, int maxColors
) {
    if (maxColors <= 0 || pixelCount <= 0) return 0;
    std::vector<Entry> e = buildEntries(pixels, size_t(pixelCount));
    if (e.empty()) return 0;
    const size_t k = std::min(size_t(maxColors), e.size());

    std::vector<float> cr, cg, cb;
    if (e.size() <= size_t(maxColors)) {
        // Few enough distinct colours: the palette is exactly those colours.
        for (const auto& x : e) { cr.push_back(x.r); cg.push_back(x.g); cb.push_back(x.b); }
    } else {
        // ── Variance-driven median cut ──
        std::vector<Box> boxes;
        boxes.push_back(makeBox(e, 0, e.size()));
        while (boxes.size() < k) {
            size_t best = boxes.size();
            for (size_t i = 0; i < boxes.size(); ++i) {
                if (boxes[i].hi - boxes[i].lo < 2) continue;
                if (best == boxes.size() || boxes[i].sse > boxes[best].sse) best = i;
            }
            if (best == boxes.size()) break;
            const Box b = boxes[best];
            std::sort(e.begin() + b.lo, e.begin() + b.hi,
                [ax = b.axis](const Entry& x, const Entry& y) { return channel(x, ax) < channel(y, ax); });
            double total = 0;
            for (size_t i = b.lo; i < b.hi; ++i) total += e[i].n;
            double acc = 0;
            size_t cut = b.lo + 1;
            for (size_t i = b.lo; i < b.hi - 1; ++i) {
                acc += e[i].n;
                cut = i + 1;
                if (acc >= total / 2) break;
            }
            boxes[best] = makeBox(e, b.lo, cut);
            boxes.push_back(makeBox(e, cut, b.hi));
        }
        for (const Box& b : boxes) {
            double w = 0, r = 0, g = 0, bl = 0;
            for (size_t i = b.lo; i < b.hi; ++i) {
                w += e[i].n; r += e[i].r * e[i].n; g += e[i].g * e[i].n; bl += e[i].b * e[i].n;
            }
            cr.push_back(float(r / w)); cg.push_back(float(g / w)); cb.push_back(float(bl / w));
        }

        // ── Weighted k-means refinement ──
        const size_t nc = cr.size();
        std::vector<uint32_t> assign(e.size(), 0);
        std::vector<double> sw(nc), sr(nc), sg(nc), sb(nc);
        for (int iter = 0; iter < 6; ++iter) {
            std::fill(sw.begin(), sw.end(), 0.0);
            std::fill(sr.begin(), sr.end(), 0.0);
            std::fill(sg.begin(), sg.end(), 0.0);
            std::fill(sb.begin(), sb.end(), 0.0);
            size_t worst = 0;
            double worstErr = -1;
            for (size_t i = 0; i < e.size(); ++i) {
                uint32_t bi = 0;
                float bd = dist2(e[i].r, e[i].g, e[i].b, cr[0], cg[0], cb[0]);
                for (size_t c = 1; c < nc; ++c) {
                    const float d = dist2(e[i].r, e[i].g, e[i].b, cr[c], cg[c], cb[c]);
                    if (d < bd) { bd = d; bi = uint32_t(c); }
                }
                assign[i] = bi;
                sw[bi] += e[i].n; sr[bi] += e[i].r * e[i].n; sg[bi] += e[i].g * e[i].n; sb[bi] += e[i].b * e[i].n;
                const double err = bd * e[i].n;
                if (err > worstErr) { worstErr = err; worst = i; }
            }
            for (size_t c = 0; c < nc; ++c) {
                if (sw[c] > 0) {
                    cr[c] = float(sr[c] / sw[c]); cg[c] = float(sg[c] / sw[c]); cb[c] = float(sb[c] / sw[c]);
                } else {
                    // Empty cluster: take over the worst-fitting colour.
                    cr[c] = e[worst].r; cg[c] = e[worst].g; cb[c] = e[worst].b;
                    worstErr = -1;
                }
            }
        }
    }

    // ── Round, keep entries distinct, sort by coverage ──
    const size_t nc = cr.size();
    std::vector<uint32_t> keys(nc);
    for (size_t c = 0; c < nc; ++c) {
        keys[c] = (uint32_t(std::lround(std::min(255.f, std::max(0.f, cr[c])))) << 16) |
                  (uint32_t(std::lround(std::min(255.f, std::max(0.f, cg[c])))) << 8) |
                  uint32_t(std::lround(std::min(255.f, std::max(0.f, cb[c]))));
    }
    // Two centroids rounding to the same colour: replace the duplicate with
    // the entry farthest from the palette (keeps the requested count).
    for (size_t c = 0; c < nc; ++c) {
        for (size_t d = 0; d < c; ++d) {
            if (keys[d] != keys[c]) continue;
            float far = -1;
            uint32_t farKey = keys[c];
            for (const auto& x : e) {
                const uint32_t xk = (uint32_t(std::lround(x.r)) << 16) |
                                    (uint32_t(std::lround(x.g)) << 8) | uint32_t(std::lround(x.b));
                if (std::find(keys.begin(), keys.end(), xk) != keys.end()) continue;
                float nearest = 1e30f;
                for (size_t q = 0; q < nc; ++q) {
                    nearest = std::min(nearest, dist2(x.r, x.g, x.b, float((keys[q] >> 16) & 255),
                                                      float((keys[q] >> 8) & 255), float(keys[q] & 255)));
                }
                if (nearest > far) { far = nearest; farKey = xk; }
            }
            keys[c] = farKey;
            break;
        }
    }
    std::vector<std::pair<double, uint32_t>> ranked;
    ranked.reserve(nc);
    {
        std::vector<double> cover(nc, 0.0);
        for (const auto& x : e) {
            size_t bi = 0;
            float bd = 1e30f;
            for (size_t q = 0; q < nc; ++q) {
                const float d = dist2(x.r, x.g, x.b, float((keys[q] >> 16) & 255),
                                      float((keys[q] >> 8) & 255), float(keys[q] & 255));
                if (d < bd) { bd = d; bi = q; }
            }
            cover[bi] += x.n;
        }
        for (size_t q = 0; q < nc; ++q) ranked.push_back({ cover[q], keys[q] });
    }
    std::stable_sort(ranked.begin(), ranked.end(),
        [](const auto& a, const auto& b) { return a.first > b.first; });

    int written = 0;
    for (size_t q = 0; q < ranked.size(); ++q) {
        const uint32_t key = ranked[q].second;
        bool dup = false;
        for (int w = 0; w < written; ++w) {
            const uint8_t* p = paletteOut + w * 4;
            if (((uint32_t(p[0]) << 16) | (uint32_t(p[1]) << 8) | p[2]) == key) { dup = true; break; }
        }
        if (dup) continue;
        uint8_t* p = paletteOut + written * 4;
        p[0] = uint8_t((key >> 16) & 255);
        p[1] = uint8_t((key >> 8) & 255);
        p[2] = uint8_t(key & 255);
        p[3] = 255;
        ++written;
    }
    return written;
}
