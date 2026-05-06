/**
 * Per-stamp color modulation for `Brush.colorDyn`.
 *
 * The stamp engine calls `applyColorJitter` once per stamp (when
 * `colorDyn.perStamp`) or once per stroke (when off). Returns a fresh RGB
 * triple in [0, 1]; the engine then converts to 0–255 for non-HDR layers or
 * uses the floats directly for rgba32f.
 *
 * Strategy:
 *  - Convert primary→HSV (HDR primaries with rgb >1 are treated as HDR — we
 *    preserve the original value in `vScale` and reapply it after jitter so
 *    HDR brushes don't get clamped).
 *  - Apply hue / saturation / brightness shifts derived from each curve via
 *    `resolveSymmetric` (signed swing), scaled to sensible ranges.
 *  - `purity` pulls the colour toward grey (saturation reduction) by amount.
 *  - `fgBgJitter` swaps fg and bg with a probability driven by the curve.
 */
import type { ColorDynamics, RGBAColor } from "@/types";
import { resolveDynamic, resolveSymmetric, type StampInputs } from "./dynamicsResolver";

interface RGB {
  r: number;
  g: number;
  b: number;
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const v = max;
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, v };
}

function hsvToRgb(h: number, s: number, v: number): RGB {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return { r: r + m, g: g + m, b: b + m };
}

export interface ResolvedColor {
  /** RGB in [0, 1+] (HDR may exceed 1). */
  r: number;
  g: number;
  b: number;
  /** Alpha in [0, 1]. */
  a: number;
}

/**
 * Resolve the per-stamp color from primary/secondary + colorDyn state.
 *
 * `inputs` is the per-stamp dynamics snapshot. When `inputs` is null (e.g.
 * for stroke-level resolution) the engine should pre-compute one resolution
 * with a fixed-hash inputs at the stroke start and reuse the result.
 */
export function resolveStampColor(
  primary: RGBAColor,
  secondary: RGBAColor,
  dyn: ColorDynamics,
  inputs: StampInputs,
): ResolvedColor {
  // FG/BG mix as a continuous lerp in float space. The curve drives the mix
  // amount per stamp, so:
  //   - identity curve + Fade source → linear gradient from FG to BG over
  //     the fade window.
  //   - identity curve + Random source → smoothly-varying mix between the
  //     two colors (because `random` is 1-D smooth noise).
  //   - jitter = 0 → mix = 0 (pure FG).
  // Mix ranges over [0, jitter], so a 50% setting fully reaches "halfway
  // between FG and BG" at the curve's peak — matching Photoshop's slider
  // semantics.
  const bgMix = Math.max(0, Math.min(1, 1 - resolveDynamic(dyn.fgBgJitter, inputs)));
  const base: RGBAColor = {
    r: primary.r + (secondary.r - primary.r) * bgMix,
    g: primary.g + (secondary.g - primary.g) * bgMix,
    b: primary.b + (secondary.b - primary.b) * bgMix,
    a: primary.a + (secondary.a - primary.a) * bgMix,
  };

  // Extract HDR scale: if any RGB > 1 we're in HDR; preserve max value, normalise
  // the rest before HSV conversion to avoid clamping.
  const peak = Math.max(base.r, base.g, base.b, 1);
  const nr = base.r / peak;
  const ng = base.g / peak;
  const nb = base.b / peak;
  const { h, s, v } = rgbToHsv(nr, ng, nb);

  // Hue: ±180° at jitter=1
  const dh = resolveSymmetric(dyn.hueJitter, inputs) * 180;
  // Saturation: ±1.0 at jitter=1, clamped to [0, 1]
  const ds = resolveSymmetric(dyn.saturationJitter, inputs);
  // Brightness (Value): ±1.0 at jitter=1, clamped to [0, 1] in LDR
  const dv = resolveSymmetric(dyn.brightnessJitter, inputs);
  // Purity: 0..1 — multiplicative reduction of saturation
  const purityMul = resolveDynamic(dyn.purityJitter, inputs);

  const newH = h + dh;
  const newS = Math.max(0, Math.min(1, (s + ds) * purityMul));
  const newV = Math.max(0, Math.min(1, v + dv));

  const out = hsvToRgb(newH, newS, newV);
  return {
    r: out.r * peak,
    g: out.g * peak,
    b: out.b * peak,
    a: base.a,
  };
}
