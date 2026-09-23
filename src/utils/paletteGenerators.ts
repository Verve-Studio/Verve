import type { RGBAColor } from "@/types";
import { linearToSrgbChannel, srgbToLinearChannel } from "./pixelFormatConvert";

// ─── HSL → RGBA ───────────────────────────────────────────────────────────────

export function hslToRgba(h: number, s: number, l: number): RGBAColor {
  h = ((h % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c);
  };
  return { r: f(0), g: f(8), b: f(4), a: 255 };
}

// ─── Color Wheel ──────────────────────────────────────────────────────────────

export type SchemeType =
  | "complementary"
  | "analogous"
  | "triadic"
  | "tetradic"
  | "split-complementary";

export interface ColorWheelOptions {
  baseHue: number; // 0–360
  scheme: SchemeType;
  count: number; // ≥ 2
  saturation: number; // 0–1
  lightness: number; // 0–1
}

const SCHEME_OFFSETS: Record<Exclude<SchemeType, "analogous">, number[]> = {
  complementary: [0, 180],
  triadic: [0, 120, 240],
  tetradic: [0, 90, 180, 270],
  "split-complementary": [0, 150, 210],
};

export function generateColorWheel(opts: ColorWheelOptions): RGBAColor[] {
  const { baseHue, scheme, count, saturation, lightness } = opts;

  if (scheme === "analogous") {
    const range = 80;
    return Array.from({ length: count }, (_, i) => {
      const hue = baseHue - range / 2 + (i * range) / Math.max(count - 1, 1);
      return hslToRgba(hue, saturation, lightness);
    });
  }

  const angles = SCHEME_OFFSETS[scheme];
  const nHues = angles.length;
  const perHue = Math.ceil(count / nHues);
  const lRange = perHue > 1 ? 22 : 0;

  return Array.from({ length: count }, (_, i) => {
    const hi = i % nHues;
    const li = Math.floor(i / nHues);
    const lOffset = perHue > 1 ? (li / (perHue - 1) - 0.5) * lRange : 0;
    const l = Math.max(0.15, Math.min(0.85, lightness + lOffset / 100));
    return hslToRgba(baseHue + angles[hi], saturation, l);
  });
}

// ─── Time of Day ──────────────────────────────────────────────────────────────
//
// Relights a palette for a time of day (dawn, day, dusk, night). A convincing
// relight is not a darker or lighter tint of the day colour: the light's own
// colour pulls every hue towards it, shadows take the colour of the ambient
// sky, and lit surfaces take the colour of the key light (sun or moon). At
// night the eye's rods take over as well (Purkinje shift) — reds collapse
// towards black while blues and greens keep their brightness. Work is done in
// OKLab so lightness, chroma and hue move independently and evenly.
//
// For every source colour the ramp is: shadows → base → lit highlights.

export type TimeOfDay = "dawn" | "day" | "dusk" | "night";

export const TIME_OF_DAY_MODES: readonly TimeOfDay[] = ["dawn", "day", "dusk", "night"];

export interface TimeOfDaySettings {
  /** Light tint hue, HSL degrees. */
  tintHue: number;
  /** 0–1: how far colours are pulled onto the tint. */
  tintStrength: number;
  /** Exposure drop: 0–1 darkens; negative brightens (daylight). */
  darkness: number;
  /** 0–1: how much of each colour's own chroma survives. */
  colorRetention: number;
  /** 0–3 shadow steps per colour. */
  shadowSteps: number;
  /** 0–1: how deep the darkest shadow goes. */
  shadowDepth: number;
  /** 0–3 lit highlight steps per colour. */
  highlightSteps: number;
  /** 0–1: how bright the brightest lit step gets. */
  highlightStrength: number;
  /** Key light hue (moon / sun), HSL degrees. */
  lightHue: number;
  /** Ambient shadow hue (sky fill), HSL degrees. */
  shadowHue: number;
  /** Keep the day colours in the generated palette. */
  includeSource: boolean;
}

export interface TimeOfDayOptions extends TimeOfDaySettings {
  mode: TimeOfDay;
  sourceSwatches: RGBAColor[];
}

export interface TimeOfDayRamp {
  source: RGBAColor;
  /** Darkest first. */
  shadows: RGBAColor[];
  base: RGBAColor;
  /** Dimmest first. */
  highlights: RGBAColor[];
}

export type TimeOfDayPreset = Pick<
  TimeOfDaySettings,
  "tintHue" | "tintStrength" | "darkness" | "colorRetention" | "lightHue" | "shadowHue"
> & { label: string };

/** Per-mode behaviour: the physics constants behind the shared options,
 *  UI wording, and presets. */
export interface TimeOfDayProfile {
  label: string;
  /** 0–1: rod (scotopic) weighting of lightness. */
  purkinje: number;
  /** Tint chroma at full strength (OKLab units). */
  tintChroma: number;
  shadowChroma: number;
  /** Chroma of the key light in lit highlights. */
  lightChroma: number;
  /** How much of the darkness value becomes exposure loss. */
  darknessScale: number;
  /** Wording and range of the exposure slider. */
  exposureLabel: string;
  /** Exposure slider shows `-darkness` (brighter = positive). */
  exposureInverted: boolean;
  exposureRange: [number, number];
  highlightTitle: string;
  lightHueLabel: string;
  presets: readonly TimeOfDayPreset[];
  defaults: TimeOfDaySettings;
}

const sharedSteps = {
  shadowSteps: 2,
  shadowDepth: 0.7,
  highlightSteps: 1,
  highlightStrength: 0.7,
  includeSource: true,
};

function profile(
  p: Omit<TimeOfDayProfile, "defaults">,
  steps: Partial<typeof sharedSteps> = {},
): TimeOfDayProfile {
  const { label: _label, ...first } = p.presets[0];
  return { ...p, defaults: { ...first, ...sharedSteps, ...steps } };
}

export const TIME_OF_DAY_PROFILES: Record<TimeOfDay, TimeOfDayProfile> = {
  dawn: profile(
    {
      label: "Dawn",
      purkinje: 0.15,
      tintChroma: 0.09,
      shadowChroma: 0.06,
      lightChroma: 0.08, // soft pink-gold light
      darknessScale: 0.6,
      exposureLabel: "Darkness",
      exposureInverted: false,
      exposureRange: [0, 100],
      highlightTitle: "Sunlit highlights",
      lightHueLabel: "Sun hue",
      presets: [
        { label: "Rosy Dawn", tintHue: 340, tintStrength: 0.45, darkness: 0.25, colorRetention: 0.55, lightHue: 30, shadowHue: 250 },
        { label: "Misty Dawn", tintHue: 210, tintStrength: 0.4, darkness: 0.3, colorRetention: 0.5, lightHue: 45, shadowHue: 220 },
        { label: "Golden Dawn", tintHue: 40, tintStrength: 0.45, darkness: 0.2, colorRetention: 0.6, lightHue: 42, shadowHue: 240 },
      ],
    },
  ),
  day: profile(
    {
      label: "Day",
      purkinje: 0,
      tintChroma: 0.06,
      shadowChroma: 0.05,
      lightChroma: 0.06,
      darknessScale: 0.5,
      exposureLabel: "Exposure",
      exposureInverted: true,
      exposureRange: [-50, 50],
      highlightTitle: "Sunlit highlights",
      lightHueLabel: "Sun hue",
      presets: [
        { label: "Noon", tintHue: 50, tintStrength: 0.15, darkness: -0.05, colorRetention: 0.95, lightHue: 52, shadowHue: 230 },
        { label: "Afternoon", tintHue: 35, tintStrength: 0.35, darkness: 0, colorRetention: 0.85, lightHue: 38, shadowHue: 215 },
        { label: "Overcast", tintHue: 210, tintStrength: 0.3, darkness: 0.15, colorRetention: 0.6, lightHue: 210, shadowHue: 220 },
      ],
    },
  ),
  dusk: profile(
    {
      label: "Dusk",
      purkinje: 0.25,
      tintChroma: 0.12,
      shadowChroma: 0.07,
      lightChroma: 0.09, // warm orange rim light
      darknessScale: 0.65,
      exposureLabel: "Darkness",
      exposureInverted: false,
      exposureRange: [0, 100],
      highlightTitle: "Sunlit highlights",
      lightHueLabel: "Sun hue",
      presets: [
        { label: "Golden Hour", tintHue: 28, tintStrength: 0.55, darkness: 0.3, colorRetention: 0.45, lightHue: 28, shadowHue: 265 },
        { label: "Purple Dusk", tintHue: 280, tintStrength: 0.6, darkness: 0.4, colorRetention: 0.35, lightHue: 20, shadowHue: 290 },
        { label: "Blue Hour", tintHue: 225, tintStrength: 0.55, darkness: 0.45, colorRetention: 0.35, lightHue: 35, shadowHue: 245 },
      ],
    },
  ),
  night: profile(
    {
      label: "Night",
      purkinje: 0.6,
      tintChroma: 0.11,
      shadowChroma: 0.07,
      lightChroma: 0.045, // bleached moonlight
      darknessScale: 0.75,
      exposureLabel: "Darkness",
      exposureInverted: false,
      exposureRange: [0, 100],
      highlightTitle: "Moonlit highlights",
      lightHueLabel: "Moon hue",
      presets: [
        { label: "Moonlight", tintHue: 225, tintStrength: 0.75, darkness: 0.55, colorRetention: 0.2, lightHue: 205, shadowHue: 250 },
        { label: "Violet Dusk", tintHue: 265, tintStrength: 0.7, darkness: 0.45, colorRetention: 0.3, lightHue: 220, shadowHue: 290 },
        { label: "Teal Night", tintHue: 195, tintStrength: 0.7, darkness: 0.55, colorRetention: 0.2, lightHue: 180, shadowHue: 220 },
        { label: "Midnight", tintHue: 238, tintStrength: 0.85, darkness: 0.75, colorRetention: 0.08, lightHue: 210, shadowHue: 263 },
      ],
    },
  ),
};

type Lab = { L: number; a: number; b: number };

const toLin = (c: number): number => srgbToLinearChannel(c / 255);

function linToOklab(r: number, g: number, b: number): Lab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToLin({ L, a, b }: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLab → sRGB bytes, reducing chroma (never hue or lightness) to fit. */
function oklabToRgba(lab: Lab): RGBAColor {
  const L = Math.max(0, Math.min(1, lab.L));
  const inGamut = (k: number): boolean =>
    oklabToLin({ L, a: lab.a * k, b: lab.b * k }).every(
      (v) => v >= -1e-4 && v <= 1 + 1e-4,
    );
  let k = 1;
  if (!inGamut(1)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(mid)) lo = mid;
      else hi = mid;
    }
    k = lo;
  }
  const [r, g, b] = oklabToLin({ L, a: lab.a * k, b: lab.b * k });
  const enc = (v: number): number =>
    Math.round(Math.max(0, Math.min(1, linearToSrgbChannel(Math.max(0, v)))) * 255);
  return { r: enc(r), g: enc(g), b: enc(b), a: 255 };
}

/** Unit OKLab (a, b) direction of an HSL hue. Shared with the Time of Day
 *  adjustment so the palette and the image relight agree. */
export function hueDirection(hue: number): [number, number] {
  const c = hslToRgba(hue, 0.85, 0.5);
  const lab = linToOklab(toLin(c.r), toLin(c.g), toLin(c.b));
  const len = Math.hypot(lab.a, lab.b) || 1;
  return [lab.a / len, lab.b / len];
}

const lerp = (x: number, y: number, t: number): number => x + (y - x) * t;

/** Night uses the full rod weighting (0.6); lighter modes blend towards the
 *  colour's own OKLab lightness. */
export const PURKINJE_FULL = 0.6;

export function generateTimeOfDayRamps(opts: TimeOfDayOptions): TimeOfDayRamp[] {
  const prof = TIME_OF_DAY_PROFILES[opts.mode];
  const [tintA, tintB] = hueDirection(opts.tintHue);
  const [shadA, shadB] = hueDirection(opts.shadowHue);
  const [lightA, lightB] = hueDirection(opts.lightHue);
  const exposure = 1 - opts.darkness * prof.darknessScale;

  return opts.sourceSwatches.map((source) => {
    const r = toLin(source.r);
    const g = toLin(source.g);
    const b = toLin(source.b);
    const lab = linToOklab(r, g, b);
    // Purkinje shift: rod-weighted luminance keeps blues / greens and drops
    // reds, blended with the photopic luminance.
    const yDay = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const yRod = 0.07 * r + 0.45 * g + 0.48 * b;
    const rodL = Math.cbrt(lerp(yDay, yRod, prof.purkinje));
    const srcL = lerp(lab.L, rodL, Math.min(1, prof.purkinje / PURKINJE_FULL));
    const baseL = srcL * exposure;

    // Dark colours can't carry much chroma; scale the tint with lightness.
    const tintC = prof.tintChroma * Math.min(1, baseL / 0.45);
    const base: Lab = {
      L: baseL,
      a: lab.a * opts.colorRetention + tintA * tintC * opts.tintStrength,
      b: lab.b * opts.colorRetention + tintB * tintC * opts.tintStrength,
    };

    const shadows: RGBAColor[] = [];
    for (let i = opts.shadowSteps; i >= 1; i--) {
      const t = (i / opts.shadowSteps) * opts.shadowDepth;
      const L = baseL * (1 - 0.8 * t);
      const shadC = prof.shadowChroma * Math.min(1, L / 0.35);
      shadows.push(
        oklabToRgba({
          L,
          a: lerp(base.a, shadA * shadC, t) * (1 - 0.3 * t),
          b: lerp(base.b, shadB * shadC, t) * (1 - 0.3 * t),
        }),
      );
    }

    const highlights: RGBAColor[] = [];
    // Lit surfaces: brighter than the base, never brighter than a pale lit
    // version of the day colour, and pulled towards the key light.
    const peakL = Math.min(0.94, Math.max(baseL + 0.18, lab.L * 0.92 + 0.08));
    for (let i = 1; i <= opts.highlightSteps; i++) {
      const t = (i / opts.highlightSteps) * opts.highlightStrength;
      const L = lerp(baseL, peakL, t);
      highlights.push(
        oklabToRgba({
          L,
          a: lerp(base.a, lightA * prof.lightChroma, Math.min(1, t * 0.9)),
          b: lerp(base.b, lightB * prof.lightChroma, Math.min(1, t * 0.9)),
        }),
      );
    }

    return { source, shadows, base: oklabToRgba(base), highlights };
  });
}

/** One row per source colour: [original?] shadows → base → highlights. */
export function timeOfDayRows(
  opts: TimeOfDayOptions,
  ramps: TimeOfDayRamp[] = generateTimeOfDayRamps(opts),
): RGBAColor[][] {
  return ramps.map((ramp) => [
    ...(opts.includeSource ? [ramp.source] : []),
    ...ramp.shadows,
    ramp.base,
    ...ramp.highlights,
  ]);
}

/** Flat palette in ramp order (each original followed by its gradient). */
export function generateTimeOfDayPalette(opts: TimeOfDayOptions): RGBAColor[] {
  return timeOfDayRows(opts).flat();
}

/**
 * Swatch groups marking each ramp of a flat Time of Day palette, so the
 * swatch panel keeps every original colour next to its gradient.
 */
export function timeOfDayRampGroups(
  rows: RGBAColor[][],
  mode: TimeOfDay,
): Array<{ name: string; swatchIndices: number[]; ramp: true }> {
  const label = TIME_OF_DAY_PROFILES[mode].label;
  const hex = (c: RGBAColor): string =>
    `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  let next = 0;
  return rows.map((row, i) => {
    const swatchIndices = row.map(() => next++);
    return { name: `${label} ${i + 1} (${hex(row[0])})`, swatchIndices, ramp: true };
  });
}
