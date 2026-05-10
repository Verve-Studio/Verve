/**
 * sRGB ↔ OKLab ↔ OKLCh conversions for perceptually-uniform colour
 * modulation in the brush engine.
 *
 * OKLab (Björn Ottosson, 2020) is a perceptual colour space designed for
 * image processing — equal numerical steps in OKLab correspond to roughly
 * equal perceived steps for the human eye. This is in stark contrast to
 * HSV/HSL, where a constant hue-shift moves yellow into acidic green
 * faster than it moves red into orange, and where uniform saturation
 * pushes blues toward neon and reds toward salmon. Painters' colour
 * jitter and wet-paint mixing both want perceptual uniformity, not
 * device-coordinate uniformity, so we route both through OKLab/OKLCh.
 *
 * OKLCh is OKLab in cylindrical coordinates (L, C, h) — Lightness,
 * Chroma, hue — the same relationship that LCh has with Lab. Hue jitter
 * and saturation/chroma jitter are most natural in OKLCh; brightness
 * jitter is just the L axis. Mixing two colours toward each other is
 * usually done in OKLab (linear axes — the lerp is a straight line) and
 * the result converted back to sRGB.
 *
 * All functions are colour-space-only — they don't touch alpha. Callers
 * are responsible for handling the alpha channel separately.
 */

// ─── sRGB transfer function ──────────────────────────────────────────────────

function srgbToLinear(c: number): number {
  if (c <= 0.04045) return c / 12.92;
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  if (c <= 0) return 0;
  if (c <= 0.0031308) return c * 12.92;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

// ─── sRGB ↔ OKLab ────────────────────────────────────────────────────────────
//
// Matrix coefficients from Björn Ottosson's reference implementation:
// https://bottosson.github.io/posts/oklab/
// Operates on linear-light sRGB; callers above this layer handle the gamma.

interface Lab {
  L: number;
  a: number;
  b: number;
}

function linearSrgbToOklab(r: number, g: number, b: number): Lab {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

function oklabToLinearSrgb(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

// ─── Public sRGB ↔ OKLab/OKLCh ───────────────────────────────────────────────

export interface Oklab {
  L: number;
  a: number;
  b: number;
}

export interface Oklch {
  L: number;
  C: number;
  h: number; // radians
}

/**
 * Convert sRGB-encoded RGB (0..1+, HDR allowed) to OKLab. The transfer
 * function is applied per channel; HDR channels above 1 are treated as
 * linear-light scene values (the cbrt then handles them naturally).
 */
export function srgbToOklab(r: number, g: number, b: number): Oklab {
  // For HDR (channel > 1) the sRGB transfer function isn't defined; we fall
  // back to identity in that range. This matches what most colour pipelines
  // do for "scene-linear" inputs. The lab axes still produce reasonable
  // perceptual neighbourhoods because cbrt compresses the range.
  const lr = r > 1 ? r : srgbToLinear(r);
  const lg = g > 1 ? g : srgbToLinear(g);
  const lb = b > 1 ? b : srgbToLinear(b);
  return linearSrgbToOklab(lr, lg, lb);
}

export function oklabToSrgb(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const linear = oklabToLinearSrgb(L, a, b);
  return {
    r: linear.r > 1 ? linear.r : linearToSrgb(Math.max(0, linear.r)),
    g: linear.g > 1 ? linear.g : linearToSrgb(Math.max(0, linear.g)),
    b: linear.b > 1 ? linear.b : linearToSrgb(Math.max(0, linear.b)),
  };
}

export function oklabToOklch(L: number, a: number, b: number): Oklch {
  return {
    L,
    C: Math.hypot(a, b),
    h: Math.atan2(b, a),
  };
}

export function oklchToOklab(L: number, C: number, h: number): Oklab {
  return {
    L,
    a: C * Math.cos(h),
    b: C * Math.sin(h),
  };
}

/**
 * Linearly mix two sRGB colours through OKLab. `t` is the mix weight: 0 =
 * pure A, 1 = pure B. Result is sRGB. This is the perceptually-correct
 * way to blend two paint colours — no muddy mid-greys, no acidic hue
 * trajectories.
 */
export function mixSrgbInOklab(
  ar: number, ag: number, ab: number,
  br: number, bg: number, bb: number,
  t: number,
): { r: number; g: number; b: number } {
  const A = srgbToOklab(ar, ag, ab);
  const B = srgbToOklab(br, bg, bb);
  return oklabToSrgb(
    A.L + (B.L - A.L) * t,
    A.a + (B.a - A.a) * t,
    A.b + (B.b - A.b) * t,
  );
}
