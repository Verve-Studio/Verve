/**
 * grabcut.cpp — GrabCut segmentation (Rother et al. 2004)
 *
 * Implementation outline:
 *   1. Initialise GMM components from trimap definite regions (k-means seed).
 *   2. Iterate:
 *      a. Assign each pixel to the closest GMM component (E-step).
 *      b. Re-estimate GMM parameters (M-step).
 *      c. Build an s/t graph with N-link (smoothness) and T-link (data) weights.
 *      d. Run max-flow / min-cut (push-relabel) to re-label the unknown band.
 *   3. Output binary alpha mask.
 *
 * Coordinate convention: pixel (x, y) → index y*width + x.
 */

#include "grabcut.h"
#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstring>
#include <limits>
#include <numeric>
#include <vector>
#include <random>

// ─── Compile-time constants ──────────────────────────────────────────────────

static constexpr int    MAX_K       = 10;   // max GMM components per class
static constexpr double GMM_EPS     = 1e-9; // regularisation for covariance
static constexpr float  BETA_SCALE  = 0.5f; // contrast sensitivity
static constexpr float  GAMMA       = 75.0f;// smoothness weight
static constexpr float  LAMBDA      = 9.0f * GAMMA; // strong T-link for definite pixels

// ─── Colour type ─────────────────────────────────────────────────────────────

struct Vec3 { float r, g, b; };

static inline Vec3 pixel_rgb(const uint8_t* rgba, size_t idx) {
    const uint8_t* p = rgba + idx * 4;
    return { p[0] / 255.0f, p[1] / 255.0f, p[2] / 255.0f };
}

static inline float dot(const Vec3& a, const Vec3& b) {
    return a.r*b.r + a.g*b.g + a.b*b.b;
}

static inline Vec3 sub(const Vec3& a, const Vec3& b) {
    return { a.r-b.r, a.g-b.g, a.b-b.b };
}

// ─── 3×3 symmetric matrix ops ────────────────────────────────────────────────

struct Mat3 {
    float v[9]; // row-major
    Mat3() { std::fill(v, v+9, 0.0f); }
    float& at(int r, int c) { return v[r*3+c]; }
    float  at(int r, int c) const { return v[r*3+c]; }
};

static float det3(const Mat3& m) {
    return m.v[0]*(m.v[4]*m.v[8]-m.v[5]*m.v[7])
          -m.v[1]*(m.v[3]*m.v[8]-m.v[5]*m.v[6])
          +m.v[2]*(m.v[3]*m.v[7]-m.v[4]*m.v[6]);
}

static Mat3 inv3(const Mat3& m) {
    float d = det3(m);
    if (std::abs(d) < 1e-18f) d = 1e-18f;
    float id = 1.0f / d;
    Mat3 inv;
    inv.v[0] = (m.v[4]*m.v[8]-m.v[5]*m.v[7]) * id;
    inv.v[1] = (m.v[2]*m.v[7]-m.v[1]*m.v[8]) * id;
    inv.v[2] = (m.v[1]*m.v[5]-m.v[2]*m.v[4]) * id;
    inv.v[3] = (m.v[5]*m.v[6]-m.v[3]*m.v[8]) * id;
    inv.v[4] = (m.v[0]*m.v[8]-m.v[2]*m.v[6]) * id;
    inv.v[5] = (m.v[2]*m.v[3]-m.v[0]*m.v[5]) * id;
    inv.v[6] = (m.v[3]*m.v[7]-m.v[4]*m.v[6]) * id;
    inv.v[7] = (m.v[1]*m.v[6]-m.v[0]*m.v[7]) * id;
    inv.v[8] = (m.v[0]*m.v[4]-m.v[1]*m.v[3]) * id;
    return inv;
}

static float mahal(const Vec3& c, const Vec3& mu, const Mat3& invCov) {
    Vec3 d = sub(c, mu);
    float x = invCov.at(0,0)*d.r + invCov.at(0,1)*d.g + invCov.at(0,2)*d.b;
    float y = invCov.at(1,0)*d.r + invCov.at(1,1)*d.g + invCov.at(1,2)*d.b;
    float z = invCov.at(2,0)*d.r + invCov.at(2,1)*d.g + invCov.at(2,2)*d.b;
    return x*d.r + y*d.g + z*d.b;
}

// ─── GMM ─────────────────────────────────────────────────────────────────────

struct GMM {
    int K;
    struct Component {
        Vec3   mean{};
        Mat3   cov{};
        Mat3   invCov{};
        float  detCov{ 1.0f };
        float  pi{ 0.0f };   // mixing weight
        // accumulators for M-step
        Vec3   sumC{};
        Mat3   sumCC{};
        float  n{ 0.0f };
    };
    Component comps[MAX_K];

    void init(int k) {
        K = k;
        for (int i = 0; i < K; i++) comps[i] = Component{};
    }

    /** Negative log-likelihood of colour c under this GMM. */
    float nll(const Vec3& c) const {
        float total = 0.0f;
        for (int i = 0; i < K; i++) {
            if (comps[i].pi < 1e-8f) continue;
            float m = mahal(c, comps[i].mean, comps[i].invCov);
            float logp = std::log(comps[i].pi)
                       - 0.5f * std::log(comps[i].detCov + GMM_EPS)
                       - 0.5f * m;
            total += comps[i].pi * std::exp(logp);
        }
        return (total > 1e-20f) ? -std::log(total) : 30.0f;
    }

    /** Returns index of component most likely for colour c. */
    int assign(const Vec3& c) const {
        float bestScore = std::numeric_limits<float>::max();
        int   bestK = 0;
        for (int i = 0; i < K; i++) {
            if (comps[i].pi < 1e-8f) continue;
            float m = mahal(c, comps[i].mean, comps[i].invCov);
            if (m < bestScore) { bestScore = m; bestK = i; }
        }
        return bestK;
    }

    void resetAccumulators() {
        for (int i = 0; i < K; i++) {
            comps[i].sumC  = {};
            comps[i].sumCC = {};
            comps[i].n     = 0.0f;
        }
    }

    void accumulate(int ki, const Vec3& c) {
        auto& comp = comps[ki];
        comp.sumC.r += c.r; comp.sumC.g += c.g; comp.sumC.b += c.b;
        comp.sumCC.at(0,0) += c.r*c.r; comp.sumCC.at(0,1) += c.r*c.g; comp.sumCC.at(0,2) += c.r*c.b;
        comp.sumCC.at(1,0) += c.g*c.r; comp.sumCC.at(1,1) += c.g*c.g; comp.sumCC.at(1,2) += c.g*c.b;
        comp.sumCC.at(2,0) += c.b*c.r; comp.sumCC.at(2,1) += c.b*c.g; comp.sumCC.at(2,2) += c.b*c.b;
        comp.n += 1.0f;
    }

    void update(float totalN) {
        for (int i = 0; i < K; i++) {
            auto& comp = comps[i];
            if (comp.n < 1.0f) { comp.pi = 0.0f; continue; }
            comp.pi = comp.n / totalN;
            comp.mean = { comp.sumC.r/comp.n, comp.sumC.g/comp.n, comp.sumC.b/comp.n };
            // cov = E[cc^T] - mean*mean^T + eps*I
            for (int r = 0; r < 3; r++)
                for (int cc2 = 0; cc2 < 3; cc2++) {
                    float mean_r = (&comp.mean.r)[r];
                    float mean_c = (&comp.mean.r)[cc2];
                    float c_val = comp.sumCC.at(r,cc2)/comp.n - mean_r*mean_c;
                    comp.cov.at(r,cc2) = c_val + (r==cc2 ? (float)GMM_EPS : 0.0f);
                }
            comp.detCov = det3(comp.cov);
            comp.invCov = inv3(comp.cov);
        }
    }
};

// ─── K-means seed for GMM ────────────────────────────────────────────────────

static void kmeans_init(
    GMM& gmm, const uint8_t* rgba,
    const std::vector<int>& indices, int K, unsigned seed
) {
    int n = (int)indices.size();
    if (n == 0) {
        gmm.init(K);
        for (int i = 0; i < K; i++) { gmm.comps[i].pi = 1.0f/K; gmm.comps[i].mean = {0.3f,0.3f,0.3f}; }
        return;
    }
    std::mt19937 rng(seed);
    std::uniform_int_distribution<int> dist(0, n-1);

    std::vector<Vec3> centres(K);
    centres[0] = pixel_rgb(rgba, indices[dist(rng)]);
    for (int ki = 1; ki < K; ki++) {
        // k-means++ seeding
        float total = 0.0f;
        std::vector<float> d2(n);
        for (int j = 0; j < n; j++) {
            Vec3 c = pixel_rgb(rgba, indices[j]);
            float best = std::numeric_limits<float>::max();
            for (int prev = 0; prev < ki; prev++) {
                Vec3 diff = sub(c, centres[prev]);
                float dd = diff.r*diff.r + diff.g*diff.g + diff.b*diff.b;
                best = std::min(best, dd);
            }
            d2[j] = best;
            total += best;
        }
        if (total < 1e-12f) { centres[ki] = centres[0]; continue; }
        std::uniform_real_distribution<float> uniF(0.0f, total);
        float r = uniF(rng);
        float cum = 0.0f;
        centres[ki] = centres[0];
        for (int j = 0; j < n; j++) {
            cum += d2[j];
            if (cum >= r) { centres[ki] = pixel_rgb(rgba, indices[j]); break; }
        }
    }

    // One-pass assignment → init components
    gmm.init(K);
    for (int i = 0; i < K; i++) gmm.comps[i].mean = centres[i];
    // Give each component equal weight initially
    std::vector<int> assign(n);
    for (int j = 0; j < n; j++) {
        Vec3 c = pixel_rgb(rgba, indices[j]);
        float bestD = std::numeric_limits<float>::max();
        int   bestK = 0;
        for (int ki = 0; ki < K; ki++) {
            Vec3 diff = sub(c, centres[ki]);
            float d = diff.r*diff.r + diff.g*diff.g + diff.b*diff.b;
            if (d < bestD) { bestD = d; bestK = ki; }
        }
        assign[j] = bestK;
        gmm.accumulate(bestK, c);
    }
    gmm.update((float)n);
    // Fix degenerate components
    for (int i = 0; i < K; i++)
        if (gmm.comps[i].pi < 1e-8f) {
            gmm.comps[i].pi   = 1.0f/K;
            gmm.comps[i].mean = centres[i % (int)centres.size()];
            // identity-ish covariance
            for (int r = 0; r < 3; r++) gmm.comps[i].cov.at(r,r) = 0.1f;
            gmm.comps[i].detCov = det3(gmm.comps[i].cov);
            gmm.comps[i].invCov = inv3(gmm.comps[i].cov);
        }
}

// ─── Min-cut graph (Dinic's algorithm with explicit edge lists) ──────────────
//
// Nodes: 0..N-1 = pixels, N = source (S), N+1 = sink (T).
// Edges are stored in pairs (forward, reverse) so edge index ^ 1 gives the
// reverse edge. This is the standard textbook Dinic's representation.

struct Graph {
    int W, H, N;
    int S, T;

    struct Edge {
        int   to;     // destination node
        int   next;   // next edge index in adjacency list, or -1
        float cap;    // residual capacity
    };
    std::vector<Edge> edges;
    std::vector<int>  head;      // head[node] = first edge index, or -1

    // Pending T-link capacities (set_tlink may be called before/after add_edge,
    // so we accumulate then materialise them when finalising the build).
    std::vector<float> pending_s; // S → pixel cap
    std::vector<float> pending_t; // pixel → T cap

    void init(int w, int h) {
        W = w; H = h;
        N = w * h;
        S = N;
        T = N + 1;
        head.assign(N + 2, -1);
        edges.clear();
        // Reserve roughly: 2 t-links per pixel + 2 N-links per pixel × 2 directions.
        edges.reserve((size_t)N * 6);
        pending_s.assign(N, 0.0f);
        pending_t.assign(N, 0.0f);
    }

    void add_edge(int u, int v, float cap_uv, float cap_vu) {
        edges.push_back({ v, head[u], cap_uv });
        head[u] = (int)edges.size() - 1;
        edges.push_back({ u, head[v], cap_vu });
        head[v] = (int)edges.size() - 1;
    }

    void set_tlink(int idx, float cs, float ct) {
        pending_s[idx] = cs;
        pending_t[idx] = ct;
    }

    void set_hlink(int x, int y, float w_cap) {
        if (w_cap <= 0.0f) return;
        int u = y * W + x;
        int v = y * W + (x + 1);
        add_edge(u, v, w_cap, w_cap);
    }

    void set_vlink(int x, int y, float w_cap) {
        if (w_cap <= 0.0f) return;
        int u = y * W + x;
        int v = (y + 1) * W + x;
        add_edge(u, v, w_cap, w_cap);
    }

    // Materialise S/T edges (call once before maxflow).
    void finalize_tlinks() {
        for (int i = 0; i < N; i++) {
            if (pending_s[i] > 0.0f) add_edge(S, i, pending_s[i], 0.0f);
            if (pending_t[i] > 0.0f) add_edge(i, T, pending_t[i], 0.0f);
        }
    }

    // ── Dinic's algorithm ────────────────────────────────────────────────────

    std::vector<int> level;   // BFS level from S; -1 = unreachable
    std::vector<int> iter;    // current-edge pointer for DFS

    bool bfs_levels() {
        level.assign(N + 2, -1);
        std::vector<int> q;
        q.reserve(N + 2);
        level[S] = 0;
        q.push_back(S);
        for (size_t qi = 0; qi < q.size(); qi++) {
            int u = q[qi];
            for (int e = head[u]; e != -1; e = edges[e].next) {
                if (edges[e].cap > 0.0f && level[edges[e].to] < 0) {
                    level[edges[e].to] = level[u] + 1;
                    q.push_back(edges[e].to);
                }
            }
        }
        return level[T] >= 0;
    }

    std::vector<int> dfsPath; // edge indices from S along the current path

    // Find one augmenting path S→T in the level graph and push its
    // bottleneck. Iterative on purpose: the recursive version recursed once
    // per path hop, and path length grows with the BFS depth on large grid
    // graphs — enough to overflow the (small, 64 KB default) WASM stack,
    // which silently corrupts memory in release builds.
    //
    // Same semantics as the classic recursive DFS: `iter[u]` stays on an
    // edge that carried flow (it may carry more), and advances past an edge
    // once the subtree behind it is a dead end.
    float dfs_augment() {
        dfsPath.clear();
        int u = S;
        while (true) {
            if (u == T) {
                float f = std::numeric_limits<float>::infinity();
                for (int e : dfsPath) f = std::min(f, edges[e].cap);
                for (int e : dfsPath) {
                    edges[e].cap     -= f;
                    edges[e ^ 1].cap += f;
                }
                return f;
            }
            bool advanced = false;
            for (; iter[u] != -1; iter[u] = edges[iter[u]].next) {
                int e = iter[u];
                int v = edges[e].to;
                if (edges[e].cap > 0.0f && level[v] == level[u] + 1) {
                    dfsPath.push_back(e);
                    u = v;
                    advanced = true;
                    break;
                }
            }
            if (advanced) continue;
            // Dead end at u: retreat to the edge's tail and skip that edge.
            if (dfsPath.empty()) return 0.0f;
            int e = dfsPath.back();
            dfsPath.pop_back();
            u = edges[e ^ 1].to;
            iter[u] = edges[iter[u]].next;
        }
    }

    void maxflow(std::vector<uint8_t>& label) {
        finalize_tlinks();

        while (bfs_levels()) {
            iter.assign(N + 2, 0);
            for (int u = 0; u < N + 2; u++) iter[u] = head[u];
            while (true) {
                float pushed = dfs_augment();
                if (pushed <= 0.0f) break;
            }
        }

        // Min-cut S-side = nodes still reachable from S in the residual graph.
        label.assign(N, 0);
        std::vector<int> q;
        q.reserve(N + 2);
        std::vector<uint8_t> visited(N + 2, 0);
        visited[S] = 1;
        q.push_back(S);
        for (size_t qi = 0; qi < q.size(); qi++) {
            int u = q[qi];
            for (int e = head[u]; e != -1; e = edges[e].next) {
                int v = edges[e].to;
                if (edges[e].cap > 0.0f && !visited[v]) {
                    visited[v] = 1;
                    q.push_back(v);
                }
            }
        }
        for (int i = 0; i < N; i++) label[i] = visited[i] ? 1 : 0;
    }
};
// ─── Beta (contrast) estimation ──────────────────────────────────────────────

static float compute_beta(const uint8_t* rgba, int width, int height) {
    double sumSq = 0.0;
    long   count = 0;
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            Vec3 c = pixel_rgb(rgba, static_cast<size_t>(y)*width+x);
            if (x+1 < width) {
                Vec3 d = sub(c, pixel_rgb(rgba, static_cast<size_t>(y)*width+x+1));
                sumSq += d.r*d.r + d.g*d.g + d.b*d.b;
                count++;
            }
            if (y+1 < height) {
                Vec3 d = sub(c, pixel_rgb(rgba, static_cast<size_t>(y+1)*width+x));
                sumSq += d.r*d.r + d.g*d.g + d.b*d.b;
                count++;
            }
        }
    }
    if (count == 0 || sumSq < 1e-10) return 0.0f;
    return (float)(BETA_SCALE / (sumSq / count));
}

// ─── N-link weight ────────────────────────────────────────────────────────────

static inline float nlink_weight(const Vec3& ci, const Vec3& cj, float beta) {
    Vec3 d = sub(ci, cj);
    float sq = d.r*d.r + d.g*d.g + d.b*d.b;
    return GAMMA * std::exp(-beta * sq);
}

// ─── GrabCut main ─────────────────────────────────────────────────────────────

void grabcut(
    const uint8_t* rgba, int width, int height,
    const uint8_t* trimap,
    uint8_t* alpha_out,
    int iterations,
    int k
) {
    const size_t N = static_cast<size_t>(width) * height;
    if (k > MAX_K) k = MAX_K;
    if (k < 1)     k = 1;

    // ── 0. Current labelling (0=BG, 1=FG) ────────────────────────────────────
    std::vector<uint8_t> label(N);
    for (size_t i = 0; i < N; i++) {
        label[i] = (trimap[i] >= 128) ? 1 : 0; // 128=unknown default to FG; 255=FG; 0=BG
    }

    // ── 1. Compute beta ───────────────────────────────────────────────────────
    float beta = compute_beta(rgba, width, height);

    // ── 2. Precompute N-link weights ──────────────────────────────────────────
    std::vector<float> hW((size_t)(width-1)*height);
    std::vector<float> vW((size_t)width*(height-1));
    for (int y = 0; y < height; y++)
        for (int x = 0; x < width-1; x++)
            hW[(size_t)y*(width-1)+x] = nlink_weight(
                pixel_rgb(rgba, static_cast<size_t>(y)*width+x), pixel_rgb(rgba, static_cast<size_t>(y)*width+x+1), beta);
    for (int y = 0; y < height-1; y++)
        for (int x = 0; x < width; x++)
            vW[(size_t)x*(height-1)+y] = nlink_weight(
                pixel_rgb(rgba, static_cast<size_t>(y)*width+x), pixel_rgb(rgba, static_cast<size_t>(y+1)*width+x), beta);

    // ── 3. GMMs ───────────────────────────────────────────────────────────────
    GMM fgGMM, bgGMM;

    // Collect indices for each class
    std::vector<int> fgIdx, bgIdx;
    for (size_t i = 0; i < N; i++) {
        if (trimap[i] >= 128) fgIdx.push_back(static_cast<int>(i)); // FG or unknown→FG initially
        else                   bgIdx.push_back(static_cast<int>(i));
    }

    kmeans_init(fgGMM, rgba, fgIdx, k, 42);
    kmeans_init(bgGMM, rgba, bgIdx, k, 1337);

    // Per-pixel component assignment
    std::vector<int> fgComp(N, 0), bgComp(N, 0);

    // ── 4. Iterative EM + graph cut ───────────────────────────────────────────
    for (int iter = 0; iter < iterations; iter++) {

        // Step 1: Assign each pixel to best GMM component
        for (size_t i = 0; i < N; i++) {
            Vec3 c = pixel_rgb(rgba, i);
            fgComp[i] = fgGMM.assign(c);
            bgComp[i] = bgGMM.assign(c);
        }

        // Step 2: Re-estimate GMMs from current labelling
        fgGMM.resetAccumulators();
        bgGMM.resetAccumulators();
        float nFG = 0.0f, nBG = 0.0f;
        for (size_t i = 0; i < N; i++) {
            Vec3 c = pixel_rgb(rgba, i);
            if (label[i] == 1) { fgGMM.accumulate(fgComp[i], c); nFG += 1.0f; }
            else                { bgGMM.accumulate(bgComp[i], c); nBG += 1.0f; }
        }
        if (nFG < 1.0f) nFG = 1.0f;
        if (nBG < 1.0f) nBG = 1.0f;
        fgGMM.update(nFG);
        bgGMM.update(nBG);

        // Step 3: Build graph and run min-cut
        Graph graph;
        graph.init(width, height);

        for (size_t i = 0; i < N; i++) {
            Vec3 c = pixel_rgb(rgba, i);
            float nllFG = fgGMM.nll(c);
            float nllBG = bgGMM.nll(c);

            float cs, ct; // source (FG) capacity, sink (BG) capacity
            if (trimap[i] == 255) {
                // Definite FG: hard link to source
                cs = LAMBDA;
                ct = 0.0f;
            } else if (trimap[i] == 0) {
                // Definite BG: hard link to sink
                cs = 0.0f;
                ct = LAMBDA;
            } else {
                // Unknown: data term from GMM
                cs = nllBG; // cutting S→pixel costs nllBG (prob of being BG)
                ct = nllFG; // cutting pixel→T costs nllFG (prob of being FG)
            }
            graph.set_tlink(static_cast<int>(i), cs, ct);
        }

        // N-links (symmetric, already precomputed)
        for (int y = 0; y < height; y++)
            for (int x = 0; x < width-1; x++)
                graph.set_hlink(x, y, hW[(size_t)y*(width-1)+x]);
        for (int y = 0; y < height-1; y++)
            for (int x = 0; x < width; x++)
                graph.set_vlink(x, y, vW[(size_t)x*(height-1)+y]);

        graph.maxflow(label);

        // Honour trimap hard constraints after each cut
        for (size_t i = 0; i < N; i++) {
            if (trimap[i] == 255) label[i] = 1;
            else if (trimap[i] == 0) label[i] = 0;
        }
    }

    // ── 5. Write output ───────────────────────────────────────────────────────
    for (size_t i = 0; i < N; i++)
        alpha_out[i] = label[i] ? 255 : 0;
}

// ─── Hybrid GPU+WASM building blocks ─────────────────────────────────────────

static void pack_gmm(const GMM& g, float* out, int K) {
    for (int i = 0; i < K; i++) {
        float* p = out + i * 20;
        const auto& c = g.comps[i];
        if (c.pi >= 1e-8f) {
            p[0] = c.mean.r; p[1] = c.mean.g; p[2] = c.mean.b; p[3] = 0.0f;
            p[4]  = c.invCov.at(0,0); p[5]  = c.invCov.at(0,1); p[6]  = c.invCov.at(0,2); p[7]  = 0.0f;
            p[8]  = c.invCov.at(1,0); p[9]  = c.invCov.at(1,1); p[10] = c.invCov.at(1,2); p[11] = 0.0f;
            p[12] = c.invCov.at(2,0); p[13] = c.invCov.at(2,1); p[14] = c.invCov.at(2,2); p[15] = 0.0f;
            p[16] = std::log(c.pi) - 0.5f * std::log(c.detCov + (float)GMM_EPS);
            p[17] = c.pi;
            p[18] = 0.0f; p[19] = 0.0f;
        } else {
            for (int j = 0; j < 20; j++) p[j] = 0.0f;
        }
    }
}

// Reconstructs mean, invCov and pi. detCov is left untouched (unused by
// GMM::assign which only needs invCov). Components with pi==0 are kept
// degenerate (pi=0) so assign skips them.
static void unpack_gmm(GMM& g, const float* in, int K) {
    g.init(K);
    for (int i = 0; i < K; i++) {
        const float* p = in + i * 20;
        auto& c = g.comps[i];
        c.mean = { p[0], p[1], p[2] };
        c.invCov.at(0,0) = p[4];  c.invCov.at(0,1) = p[5];  c.invCov.at(0,2) = p[6];
        c.invCov.at(1,0) = p[8];  c.invCov.at(1,1) = p[9];  c.invCov.at(1,2) = p[10];
        c.invCov.at(2,0) = p[12]; c.invCov.at(2,1) = p[13]; c.invCov.at(2,2) = p[14];
        c.pi = p[17];
    }
}

float grabcut_compute_beta(const uint8_t* rgba, int w, int h) {
    return compute_beta(rgba, w, h);
}

void grabcut_kmeans_init(const uint8_t* rgba, int w, int h,
                         const uint8_t* trimap, int k, float* paramsOut) {
    if (k > MAX_K) k = MAX_K;
    if (k < 1)     k = 1;
    const size_t N = static_cast<size_t>(w) * h;
    std::vector<int> fgIdx, bgIdx;
    for (size_t i = 0; i < N; i++) {
        if (trimap[i] >= 128) fgIdx.push_back(static_cast<int>(i));
        else                   bgIdx.push_back(static_cast<int>(i));
    }
    GMM fg, bg;
    kmeans_init(fg, rgba, fgIdx, k, 42);
    kmeans_init(bg, rgba, bgIdx, k, 1337);
    pack_gmm(fg, paramsOut,           k);
    pack_gmm(bg, paramsOut + k * 20,  k);
}

void grabcut_update_gmms(const uint8_t* rgba, int w, int h,
                         const uint8_t* label, int k, float* paramsInOut) {
    if (k > MAX_K) k = MAX_K;
    if (k < 1)     k = 1;
    const size_t N = static_cast<size_t>(w) * h;
    GMM fg, bg;
    unpack_gmm(fg, paramsInOut,          k);
    unpack_gmm(bg, paramsInOut + k * 20, k);

    std::vector<int> fgComp(N, 0), bgComp(N, 0);
    for (size_t i = 0; i < N; i++) {
        Vec3 c = pixel_rgb(rgba, i);
        fgComp[i] = fg.assign(c);
        bgComp[i] = bg.assign(c);
    }

    fg.resetAccumulators();
    bg.resetAccumulators();
    float nFG = 0.0f, nBG = 0.0f;
    for (size_t i = 0; i < N; i++) {
        Vec3 c = pixel_rgb(rgba, i);
        if (label[i] == 1) { fg.accumulate(fgComp[i], c); nFG += 1.0f; }
        else                { bg.accumulate(bgComp[i], c); nBG += 1.0f; }
    }
    if (nFG < 1.0f) nFG = 1.0f;
    if (nBG < 1.0f) nBG = 1.0f;
    fg.update(nFG);
    bg.update(nBG);

    pack_gmm(fg, paramsInOut,          k);
    pack_gmm(bg, paramsInOut + k * 20, k);
}

void grabcut_mincut(const float* capS, const float* capT,
                    const float* hW, const float* vW,
                    const uint8_t* trimap, int w, int h, uint8_t* labelOut) {
    Graph graph;
    graph.init(w, h);
    const size_t N = static_cast<size_t>(w) * h;
    for (size_t i = 0; i < N; i++) graph.set_tlink(static_cast<int>(i), capS[i], capT[i]);
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w - 1; x++)
            graph.set_hlink(x, y, hW[(size_t)y * (w - 1) + x]);
    // Row-major v-link layout: vW[y*w + x] is the edge between (x,y) and (x,y+1).
    for (int y = 0; y < h - 1; y++)
        for (int x = 0; x < w; x++)
            graph.set_vlink(x, y, vW[(size_t)y * w + x]);

    std::vector<uint8_t> label;
    graph.maxflow(label);

    for (size_t i = 0; i < N; i++) {
        uint8_t v = label[i];
        if (trimap[i] == 255) v = 1;
        else if (trimap[i] == 0) v = 0;
        labelOut[i] = v;
    }
}
