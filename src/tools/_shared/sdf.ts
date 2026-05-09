/**
 * Signed-distance-field utilities for brush tips.
 *
 * The brush stamp engine samples a tip's SDF (in tip-local pixel units, sign:
 * negative inside, positive outside, ~0 on the silhouette) and converts the
 * distance to alpha via a smoothstep whose width is driven by hardness. This
 * gives clean scaling — a 24×24 source bitmap looks crisp at 200 px — and
 * naturally feathered edges for any hardness.
 *
 * `computeSdf8SSEDT` is the canonical 8-point Sequential Sweep Euclidean
 * Distance Transform: two passes, ~O(n) per pixel, no per-pixel allocations.
 * Storage is two parallel Int16Array grids (dx, dy offsets to nearest opposite
 * pixel) which keeps the inner loop hot and tight.
 *
 * Output is a `Float32Array` of width × height, units = pixels, signed:
 *   inside  → negative
 *   edge    → 0
 *   outside → positive
 */

const FAR = 30000; // fits in Int16, large enough to outclass any real distance

function pass(dx: Int16Array, dy: Int16Array, w: number, h: number): void {
  // For each cell, compare against neighbours and keep the (dx, dy) whose
  // squared length is smallest. The sweep order in 8SSEDT visits 8 neighbours
  // per pixel — 4 in each pass — so the wavefront propagates monotonically.

  // Forward pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let bx = dx[i], by = dy[i];
      let bsq = bx * bx + by * by;

      // (-1, 0)
      if (x > 0) {
        const j = i - 1;
        const cx = dx[j] - 1, cy = dy[j];
        const cs = cx * cx + cy * cy;
        if (cs < bsq) { bx = cx; by = cy; bsq = cs; }
      }
      // (0, -1)
      if (y > 0) {
        const j = i - w;
        const cx = dx[j], cy = dy[j] - 1;
        const cs = cx * cx + cy * cy;
        if (cs < bsq) { bx = cx; by = cy; bsq = cs; }
      }
      // (-1, -1)
      if (x > 0 && y > 0) {
        const j = i - 1 - w;
        const cx = dx[j] - 1, cy = dy[j] - 1;
        const cs = cx * cx + cy * cy;
        if (cs < bsq) { bx = cx; by = cy; bsq = cs; }
      }
      // (1, -1)
      if (x < w - 1 && y > 0) {
        const j = i + 1 - w;
        const cx = dx[j] + 1, cy = dy[j] - 1;
        const cs = cx * cx + cy * cy;
        if (cs < bsq) { bx = cx; by = cy; bsq = cs; }
      }
      dx[i] = bx; dy[i] = by;
    }
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let bx = dx[i], by = dy[i];
      let bsq = bx * bx + by * by;
      if (x < w - 1) {
        const j = i + 1;
        const cx = dx[j] + 1, cy = dy[j];
        const cs = cx * cx + cy * cy;
        if (cs < bsq) { bx = cx; by = cy; bsq = cs; }
      }
      dx[i] = bx; dy[i] = by;
    }
  }

  // Backward pass
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let bx = dx[i], by = dy[i];
      let bsq = bx * bx + by * by;

      if (x < w - 1) {
        const j = i + 1;
        const cx = dx[j] + 1, cy = dy[j];
        const cs = cx * cx + cy * cy;
        if (cs < bsq) { bx = cx; by = cy; bsq = cs; }
      }
      if (y < h - 1) {
        const j = i + w;
        const cx = dx[j], cy = dy[j] + 1;
        const cs = cx * cx + cy * cy;
        if (cs < bsq) { bx = cx; by = cy; bsq = cs; }
      }
      if (x > 0 && y < h - 1) {
        const j = i - 1 + w;
        const cx = dx[j] - 1, cy = dy[j] + 1;
        const cs = cx * cx + cy * cy;
        if (cs < bsq) { bx = cx; by = cy; bsq = cs; }
      }
      if (x < w - 1 && y < h - 1) {
        const j = i + 1 + w;
        const cx = dx[j] + 1, cy = dy[j] + 1;
        const cs = cx * cx + cy * cy;
        if (cs < bsq) { bx = cx; by = cy; bsq = cs; }
      }
      dx[i] = bx; dy[i] = by;
    }
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let bx = dx[i], by = dy[i];
      let bsq = bx * bx + by * by;
      if (x > 0) {
        const j = i - 1;
        const cx = dx[j] - 1, cy = dy[j];
        const cs = cx * cx + cy * cy;
        if (cs < bsq) { bx = cx; by = cy; bsq = cs; }
      }
      dx[i] = bx; dy[i] = by;
    }
  }
}

/**
 * Compute a signed distance field from an alpha mask.
 *
 * @param alpha  width*height bytes — pixels with alpha ≥ `threshold` are inside.
 * @param width
 * @param height
 * @param threshold  default 16 (treat pixels with any meaningful alpha as inside).
 * @returns Float32Array of width*height pixels, signed distances in pixel units.
 */
export function computeSdf8SSEDT(
  alpha: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 16,
): Float32Array {
  const n = width * height;
  const inDx = new Int16Array(n);
  const inDy = new Int16Array(n);
  const outDx = new Int16Array(n);
  const outDy = new Int16Array(n);

  for (let i = 0; i < n; i++) {
    const inside = alpha[i] >= threshold;
    if (inside) {
      inDx[i] = 0; inDy[i] = 0;
      outDx[i] = FAR; outDy[i] = FAR;
    } else {
      inDx[i] = FAR; inDy[i] = FAR;
      outDx[i] = 0; outDy[i] = 0;
    }
  }
  pass(inDx, inDy, width, height);
  pass(outDx, outDy, width, height);

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const din = Math.sqrt(inDx[i] * inDx[i] + inDy[i] * inDy[i]);
    const dout = Math.sqrt(outDx[i] * outDx[i] + outDy[i] * outDy[i]);
    // Convention: negative inside, positive outside.
    //   inside cell  → din = 0, dout > 0 → SDF = -dout (negative)
    //   outside cell → din > 0, dout = 0 → SDF = +din (positive)
    out[i] = din - dout;
  }
  return out;
}

/** Read alpha out of an interleaved RGBA byte buffer and run the SDF transform. */
export function computeSdfFromRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 16,
): Float32Array {
  const n = width * height;
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = rgba[i * 4 + 3];
  return computeSdf8SSEDT(alpha, width, height, threshold);
}

// ─── Base64 codec for persistence ────────────────────────────────────────────

export function sdfToBase64(sdf: Float32Array): string {
  const bytes = new Uint8Array(sdf.buffer, sdf.byteOffset, sdf.byteLength);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + chunk, bytes.length))),
    );
  }
  return btoa(bin);
}

export function sdfFromBase64(
  b64: string,
  width: number,
  height: number,
): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const out = new Float32Array(width * height);
  out.set(new Float32Array(bytes.buffer, bytes.byteOffset, width * height));
  return out;
}
