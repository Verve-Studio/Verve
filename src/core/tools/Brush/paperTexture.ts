/**
 * Procedural paper grain for brush stamps.
 *
 * Sampled per pixel inside a stamp; the engine combines it with the stamp's
 * coverage according to the brush's texture mode (`applyGrain`). Two
 * sampling spaces:
 *
 *   followBrush = false  → grain is locked to canvas coordinates so the same
 *                          paper tooth shows through every stroke (the
 *                          natural Photoshop behaviour).
 *   followBrush = true   → grain is sampled in tip-local coords, so it
 *                          rotates and translates with the brush.
 *
 * The noise is three octaves of value noise (fractal Brownian motion) with a
 * contrast stretch: a single octave reads as soft blobs, the octaves add the
 * fine tooth real paper has. No allocation per sample — the lattice is
 * reconstructed from a 32-bit hash. The WASM kernel
 * (`wasm/src/brush_stamp.cpp`) mirrors this exactly; keep the two in sync.
 */

function hash2(ix: number, iy: number, salt: number): number {
  let h =
    Math.imul(ix, 0x27d4eb2d) ^
    Math.imul(iy, 0x165667b1) ^
    Math.imul(salt, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296; // 0..1
}

function valueNoise(x: number, y: number, period: number, salt: number): number {
  const u = x / period;
  const v = y / period;
  const ixF = Math.floor(u);
  const iyF = Math.floor(v);
  let fx = u - ixF;
  let fy = v - iyF;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const ix = ixF | 0;
  const iy = iyF | 0;
  const a = hash2(ix, iy, salt) * (1 - fx) + hash2(ix + 1, iy, salt) * fx;
  const b = hash2(ix, iy + 1, salt) * (1 - fx) + hash2(ix + 1, iy + 1, salt) * fx;
  return a * (1 - fy) + b * fy;
}

/** Paper height at (x, y) in [0, 1] — 1 = peak, 0 = valley. */
export function grainNoise(x: number, y: number, scale: number): number {
  const p = scale < 2 ? 2 : scale;
  const p2 = p / 2.13 < 1.5 ? 1.5 : p / 2.13;
  const p3 = p / 4.37 < 1.25 ? 1.25 : p / 4.37;
  const f =
    0.5 * valueNoise(x, y, p, 1) +
    0.3 * valueNoise(x, y, p2, 2) +
    0.2 * valueNoise(x, y, p3, 3);
  // The octave mix clusters around 0.5; stretch it back to full range.
  const n = (f - 0.5) * 1.8 + 0.5;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Combine stamp coverage with the paper height `n`.
 *
 * `invAlpha` is 1 / the stamp's opacity ceiling (0..1, ≥ 1e-3): subtract
 * mode removes a fixed tooth depth from the *paint alpha*, so the faint
 * paint of a light, low-opacity stroke only catches the peaks while dense
 * paint fills the valleys too.
 */
export function applyGrain(
  coverage: number,
  n: number,
  amount: number,
  subtract: boolean,
  invAlpha: number,
): number {
  const tooth = amount * (1 - n);
  if (!subtract) return coverage * (1 - tooth);
  const c = coverage - tooth * invAlpha;
  return c > 0 ? c : 0;
}
