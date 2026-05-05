import type { RGBAColor } from "@/types";
import { rgbaToHsl } from "./swatchSort";

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

// ─── Night Color ──────────────────────────────────────────────────────────────

export interface NightColorOptions {
  sourceSwatches: RGBAColor[];
  steps: number; // 2–4
}

export function generateNightColor(opts: NightColorOptions): RGBAColor[] {
  const { sourceSwatches, steps } = opts;
  const out: RGBAColor[] = [];

  for (const swatch of sourceSwatches) {
    out.push(swatch);
    const { h, s, l } = rgbaToHsl(swatch);
    for (let i = 1; i <= steps; i++) {
      const f = i / (steps + 1);
      const newS = s * (1 - f * 0.45);
      const newL = l * (1 - f * 0.72);
      out.push(hslToRgba(h, newS, newL));
    }
  }

  return out;
}
