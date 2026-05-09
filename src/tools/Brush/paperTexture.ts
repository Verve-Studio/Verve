/**
 * Procedural paper-grain texture for brush stamps.
 *
 * Sampled per pixel inside a stamp's coverage band; multiplies the stamp's
 * coverage so the resulting paint inherits the underlying "tooth" of the
 * paper. Two sampling modes:
 *
 *   followBrush = false  → grain is locked to canvas coordinates so the same
 *                          paper bumps show through every brush stroke (the
 *                          natural Photoshop behaviour).
 *   followBrush = true   → grain is sampled in tip-local coords, so the grain
 *                          rotates and translates with the brush.
 *
 * The noise is value noise interpolated bilinearly from a hashed integer
 * lattice, periodic at `scale` pixels. No allocation per sample: the lattice
 * is reconstructed on the fly from a fast 32-bit hash. This is fast enough
 * to call inside the per-pixel stamp loop without a measurable perf hit, and
 * trivially deterministic for repeated strokes.
 */

function hash2(ix: number, iy: number): number {
  let h = (ix * 0x27d4eb2d) ^ (iy * 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 0x100000000; // 0..1
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Sample value noise at (x, y) with a given period (lattice spacing in px).
 * Returns 0..1.
 */
export function valueNoise(x: number, y: number, period: number): number {
  const u = x / period;
  const v = y / period;
  const ix = Math.floor(u);
  const iy = Math.floor(v);
  const fx = smoothstep(u - ix);
  const fy = smoothstep(v - iy);
  const h00 = hash2(ix, iy);
  const h10 = hash2(ix + 1, iy);
  const h01 = hash2(ix, iy + 1);
  const h11 = hash2(ix + 1, iy + 1);
  const a = h00 * (1 - fx) + h10 * fx;
  const b = h01 * (1 - fx) + h11 * fx;
  return a * (1 - fy) + b * fy;
}

/**
 * Returns a multiplicative grain factor in `[1 - amount, 1]`. Multiplying
 * stamp coverage by this gives subtle dimming where the paper has "valleys"
 * and full coverage where it has "peaks" — the behaviour painters expect.
 */
export function sampleGrain(
  x: number,
  y: number,
  amount: number,
  scale: number,
): number {
  if (amount <= 0) return 1;
  const n = valueNoise(x, y, Math.max(2, scale));
  // Bias the noise so its mean is close to 1 (no global darkening) and the
  // amplitude is controlled by `amount`.
  return 1 - amount * (1 - n);
}
