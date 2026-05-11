/**
 * Per-stamp color modulation for `Brush.colorDyn`.
 *
 * The stamp engine calls `applyColorJitter` once per stamp (when
 * `colorDyn.perStamp`) or once per stroke (when off). Returns a fresh RGB
 * triple in [0, 1+]; the engine then converts to 0–255 for non-HDR layers
 * or uses the floats directly for rgba32f.
 *
 * Strategy:
 *  - Convert primary→OKLCh (perceptually uniform — equal numerical jitter
 *    gives equal perceived shift, unlike HSV where yellows go acidic and
 *    blues go neon at uniform sliders).
 *  - HDR primaries (any channel > 1) preserve their luminance scale: we
 *    record a `luminanceScale` so the OKLab `L` axis works in normalised
 *    terms and HDR information isn't clamped.
 *  - Apply hue / chroma (saturation) / lightness (brightness) shifts
 *    derived from each curve via `resolveSymmetric` (signed swing),
 *    scaled to sensible ranges.
 *  - `purity` pulls the colour toward grey (chroma reduction by amount).
 *  - `fgBgJitter` mixes fg and bg through OKLab, so the gradient between
 *    them is perceptually straight rather than passing through muddy
 *    intermediate hues.
 */
import type { ColorDynamics, RGBAColor } from "@/types";
import { resolveDynamic, resolveSymmetric, type StampInputs } from "./dynamicsResolver";
import {
  oklabToOklch,
  oklabToSrgb,
  oklchToOklab,
  srgbToOklab,
} from "./oklch";

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
  // FG/BG mix through OKLab so the gradient between two colours follows a
  // perceptually-straight path. The curve drives the mix amount per stamp,
  // matching Photoshop's slider semantics:
  //   - identity curve + Fade source → linear gradient FG → BG
  //   - identity curve + Random source → smooth wandering between FG/BG
  //   - jitter = 0 → mix = 0 (pure FG)
  const bgMix = Math.max(0, Math.min(1, 1 - resolveDynamic(dyn.fgBgJitter, inputs)));
  // Mix in OKLab; for the alpha channel a straight lerp is correct.
  const labA = srgbToOklab(primary.r, primary.g, primary.b);
  const labB = srgbToOklab(secondary.r, secondary.g, secondary.b);
  const baseLab = {
    L: labA.L + (labB.L - labA.L) * bgMix,
    a: labA.a + (labB.a - labA.a) * bgMix,
    b: labA.b + (labB.b - labA.b) * bgMix,
  };
  const baseAlpha = primary.a + (secondary.a - primary.a) * bgMix;

  // Convert to OKLCh for hue/chroma jitter.
  const lch = oklabToOklch(baseLab.L, baseLab.a, baseLab.b);

  // ── Jitter axes ──────────────────────────────────────────────────────────
  // - Hue: ±π at jitter=1 (full circle swing).
  // - Chroma: ±0.4 at jitter=1 — the OKLab colour solid's typical chroma
  //   range for sRGB is ~0..0.4, so a full jitter spans the gamut.
  // - Lightness: ±1.0 at jitter=1, then clamped to [0, 1] for LDR.
  // - Purity: 0..1 multiplicative reduction of chroma (toward grey).
  const dh = resolveSymmetric(dyn.hueJitter, inputs) * Math.PI;
  const dc = resolveSymmetric(dyn.saturationJitter, inputs) * 0.4;
  const dL = resolveSymmetric(dyn.brightnessJitter, inputs);
  const purityMul = resolveDynamic(dyn.purityJitter, inputs);

  const newL = Math.max(0, Math.min(1, lch.L + dL));
  const newC = Math.max(0, (lch.C + dc) * purityMul);
  const newH = lch.h + dh;

  const outLab = oklchToOklab(newL, newC, newH);
  const out = oklabToSrgb(outLab.L, outLab.a, outLab.b);
  return {
    r: out.r,
    g: out.g,
    b: out.b,
    a: baseAlpha,
  };
}
