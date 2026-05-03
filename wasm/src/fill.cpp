#include "fill.h"
#include <vector>
#include <stack>
#include <algorithm>
#include <cmath>

static inline int colorDist2(
    const uint8_t* pixels, int idx,
    uint8_t r, uint8_t g, uint8_t b, uint8_t a
) {
    int dr = pixels[idx]     - r;
    int dg = pixels[idx + 1] - g;
    int db = pixels[idx + 2] - b;
    int da = pixels[idx + 3] - a;
    return dr * dr + dg * dg + db * db + da * da;
}

void fill_flood(
    uint8_t* pixels, int width, int height,
    int startX, int startY,
    uint8_t fillR, uint8_t fillG, uint8_t fillB, uint8_t fillA,
    int tolerance
) {
    if (startX < 0 || startX >= width || startY < 0 || startY >= height) return;

    const int startIdx = (startY * width + startX) * 4;
    const uint8_t targetR = pixels[startIdx];
    const uint8_t targetG = pixels[startIdx + 1];
    const uint8_t targetB = pixels[startIdx + 2];
    const uint8_t targetA = pixels[startIdx + 3];

    // Nothing to do if start pixel already has the fill color
    if (targetR == fillR && targetG == fillG && targetB == fillB && targetA == fillA) return;

    const int thresh2 = tolerance * tolerance * 4;

    std::vector<bool> visited(width * height, false);

    auto matches = [&](int x, int y) -> bool {
        if (visited[y * width + x]) return false;
        const int idx = (y * width + x) * 4;
        return colorDist2(pixels, idx, targetR, targetG, targetB, targetA) <= thresh2;
    };

    struct Span { int y, x1, x2; };
    std::stack<Span> stack;
    stack.push({ startY, startX, startX });

    while (!stack.empty()) {
        auto [y, x1, x2] = stack.top();
        stack.pop();

        // Extend span leftward
        int xl = x1;
        while (xl - 1 >= 0 && matches(xl - 1, y)) --xl;

        // Extend span rightward
        int xr = x2;
        while (xr + 1 < width && matches(xr + 1, y)) ++xr;

        // Fill and mark visited
        for (int x = xl; x <= xr; ++x) {
            const int idx = (y * width + x) * 4;
            visited[y * width + x] = true;
            pixels[idx]     = fillR;
            pixels[idx + 1] = fillG;
            pixels[idx + 2] = fillB;
            pixels[idx + 3] = fillA;
        }

        // Enqueue matching runs in the rows above and below
        for (int dy : { -1, 1 }) {
            const int ny = y + dy;
            if (ny < 0 || ny >= height) continue;
            int x = xl;
            while (x <= xr) {
                while (x <= xr && !matches(x, ny)) ++x;
                if (x > xr) break;
                const int sx = x;
                while (x <= xr && matches(x, ny)) ++x;
                stack.push({ ny, sx, x - 1 });
            }
        }
    }
}

// ─── Float32 flood fill ───────────────────────────────────────────────────────

static inline float colorDistF32_2(
    const float* pixels, int idx,
    float r, float g, float b, float a
) {
    float dr = pixels[idx]     - r;
    float dg = pixels[idx + 1] - g;
    float db = pixels[idx + 2] - b;
    float da = pixels[idx + 3] - a;
    return dr*dr + dg*dg + db*db + da*da;
}

void fill_flood_f32(
    float* pixels, int width, int height,
    int startX, int startY,
    float fillR, float fillG, float fillB, float fillA,
    float tolerance
) {
    if (startX < 0 || startX >= width || startY < 0 || startY >= height) return;

    const int startIdx = (startY * width + startX) * 4;
    const float targetR = pixels[startIdx];
    const float targetG = pixels[startIdx + 1];
    const float targetB = pixels[startIdx + 2];
    const float targetA = pixels[startIdx + 3];

    if (targetR == fillR && targetG == fillG && targetB == fillB && targetA == fillA) return;

    const float thresh2 = tolerance * tolerance * 4.0f;

    std::vector<bool> visited(width * height, false);

    auto matches = [&](int x, int y) -> bool {
        if (visited[y * width + x]) return false;
        const int idx = (y * width + x) * 4;
        return colorDistF32_2(pixels, idx, targetR, targetG, targetB, targetA) <= thresh2;
    };

    struct Span { int y, x1, x2; };
    std::stack<Span> stack;
    stack.push({ startY, startX, startX });

    while (!stack.empty()) {
        auto [y, x1, x2] = stack.top();
        stack.pop();

        int xl = x1;
        while (xl - 1 >= 0 && matches(xl - 1, y)) --xl;

        int xr = x2;
        while (xr + 1 < width && matches(xr + 1, y)) ++xr;

        for (int x = xl; x <= xr; ++x) {
            const int idx = (y * width + x) * 4;
            visited[y * width + x] = true;
            pixels[idx]     = fillR;
            pixels[idx + 1] = fillG;
            pixels[idx + 2] = fillB;
            pixels[idx + 3] = fillA;
        }

        for (int dy : { -1, 1 }) {
            const int ny = y + dy;
            if (ny < 0 || ny >= height) continue;
            int x = xl;
            while (x <= xr) {
                while (x <= xr && !matches(x, ny)) ++x;
                if (x > xr) break;
                const int sx = x;
                while (x <= xr && matches(x, ny)) ++x;
                stack.push({ ny, sx, x - 1 });
            }
        }
    }
}
