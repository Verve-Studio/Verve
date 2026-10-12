import { describe, expect, it } from "vitest";
import type { RGBAColor } from "@/types";
import {
  TIME_OF_DAY_MODES,
  TIME_OF_DAY_PROFILES,
  generateColorWheel,
  generateTimeOfDayPalette,
  generateTimeOfDayRamps,
  hslToRgba,
  hueDirection,
  timeOfDayRampGroups,
  timeOfDayRows,
  type SchemeType,
  type TimeOfDayOptions,
} from "@/utils/paletteGenerators";
import { rgbaToHsl } from "@/utils/swatchSort";
import { srgbToLinearChannel } from "@/utils/pixelFormatConvert";

const isByteColor = (c: RGBAColor): boolean =>
  [c.r, c.g, c.b, c.a].every((v) => Number.isInteger(v) && v >= 0 && v <= 255);

const luminance = (c: RGBAColor): number =>
  0.2126 * srgbToLinearChannel(c.r / 255) +
  0.7152 * srgbToLinearChannel(c.g / 255) +
  0.0722 * srgbToLinearChannel(c.b / 255);

describe("hslToRgba", () => {
  it("produces primaries and greys", () => {
    expect(hslToRgba(0, 1, 0.5)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(hslToRgba(120, 1, 0.5)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(hslToRgba(240, 1, 0.5)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
    expect(hslToRgba(77, 0, 0.5)).toEqual({ r: 128, g: 128, b: 128, a: 255 });
    expect(hslToRgba(0, 1, 0)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(hslToRgba(0, 1, 1)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it("wraps hue (negative and > 360)", () => {
    expect(hslToRgba(-120, 1, 0.5)).toEqual(hslToRgba(240, 1, 0.5));
    expect(hslToRgba(480, 0.7, 0.4)).toEqual(hslToRgba(120, 0.7, 0.4));
  });

  it("round-trips with rgbaToHsl for saturated colours", () => {
    for (let h = 0; h < 360; h += 15) {
      const back = rgbaToHsl(hslToRgba(h, 1, 0.5));
      const dh = Math.min(Math.abs(back.h - h), 360 - Math.abs(back.h - h));
      expect(dh).toBeLessThan(1);
    }
  });
});

describe("generateColorWheel", () => {
  const schemes: SchemeType[] = ["complementary", "analogous", "triadic", "tetradic", "split-complementary"];

  it.each(schemes)("%s returns `count` valid colours", (scheme) => {
    for (const count of [2, 3, 5, 8]) {
      const out = generateColorWheel({ baseHue: 200, scheme, count, saturation: 0.8, lightness: 0.5 });
      expect(out).toHaveLength(count);
      expect(out.every(isByteColor)).toBe(true);
    }
  });

  it("complementary uses hues 180 degrees apart", () => {
    const [a, b] = generateColorWheel({ baseHue: 30, scheme: "complementary", count: 2, saturation: 1, lightness: 0.5 });
    expect(a).toEqual(hslToRgba(30, 1, 0.5));
    expect(b).toEqual(hslToRgba(210, 1, 0.5));
  });

  it("analogous spans 80 degrees centred on the base hue", () => {
    const out = generateColorWheel({ baseHue: 100, scheme: "analogous", count: 3, saturation: 1, lightness: 0.5 });
    expect(out).toEqual([hslToRgba(60, 1, 0.5), hslToRgba(100, 1, 0.5), hslToRgba(140, 1, 0.5)]);
  });

  it("keeps extra-lightness variants within [0.15, 0.85]", () => {
    const out = generateColorWheel({ baseHue: 0, scheme: "triadic", count: 12, saturation: 0, lightness: 0.95 });
    for (const c of out) {
      expect(c.r).toBeLessThanOrEqual(Math.round(0.85 * 255));
      expect(c.r).toBeGreaterThanOrEqual(Math.round(0.15 * 255));
    }
  });
});

describe("Time of Day", () => {
  const sources: RGBAColor[] = [
    { r: 220, g: 40, b: 40, a: 255 },
    { r: 40, g: 160, b: 60, a: 255 },
    { r: 40, g: 80, b: 220, a: 255 },
    { r: 250, g: 250, b: 250, a: 255 },
    { r: 0, g: 0, b: 0, a: 255 },
  ];
  const optsFor = (mode: (typeof TIME_OF_DAY_MODES)[number], extra: Partial<TimeOfDayOptions> = {}): TimeOfDayOptions => ({
    ...TIME_OF_DAY_PROFILES[mode].defaults,
    mode,
    sourceSwatches: sources,
    ...extra,
  });

  it("hueDirection is a unit vector", () => {
    for (let h = 0; h < 360; h += 30) {
      const [a, b] = hueDirection(h);
      expect(Math.hypot(a, b)).toBeCloseTo(1, 9);
    }
  });

  it("every profile has presets and defaults taken from its first preset", () => {
    for (const mode of TIME_OF_DAY_MODES) {
      const p = TIME_OF_DAY_PROFILES[mode];
      expect(p.presets.length).toBeGreaterThan(0);
      const { label: _label, ...first } = p.presets[0];
      expect(p.defaults).toMatchObject(first);
    }
  });

  it.each(TIME_OF_DAY_MODES)("%s ramps have the requested step counts and in-gamut bytes", (mode) => {
    const opts = optsFor(mode, { shadowSteps: 3, highlightSteps: 2 });
    const ramps = generateTimeOfDayRamps(opts);
    expect(ramps).toHaveLength(sources.length);
    for (const [i, r] of ramps.entries()) {
      expect(r.source).toBe(sources[i]);
      expect(r.shadows).toHaveLength(3);
      expect(r.highlights).toHaveLength(2);
      for (const col of [...r.shadows, r.base, ...r.highlights]) expect(isByteColor(col)).toBe(true);
    }
  });

  it.each(TIME_OF_DAY_MODES)("%s ramps get brighter from darkest shadow to brightest highlight", (mode) => {
    const ramps = generateTimeOfDayRamps(optsFor(mode, { shadowSteps: 3, highlightSteps: 3 }));
    // Chromatic mid-tones only: near-white sources are capped at the 0.94
    // highlight ceiling by design, which can sit below a brightened base.
    for (const r of ramps.slice(0, 3)) {
      const seq = [...r.shadows, r.base, ...r.highlights].map(luminance);
      for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1] - 1e-3);
    }
  });

  it("night darkens and Purkinje-shifts reds more than blues", () => {
    const night = generateTimeOfDayRamps(optsFor("night"));
    const red = night[0];
    const blue = night[2];
    expect(luminance(red.base)).toBeLessThan(luminance(sources[0]));
    const redRatio = luminance(red.base) / luminance(sources[0]);
    const blueRatio = luminance(blue.base) / luminance(sources[2]);
    expect(redRatio).toBeLessThan(blueRatio);
  });

  it("rows, flat palette and ramp groups agree", () => {
    const opts = optsFor("dusk");
    const rows = timeOfDayRows(opts);
    const perRow = 1 + opts.shadowSteps + 1 + opts.highlightSteps;
    expect(rows.every((r) => r.length === perRow)).toBe(true);
    expect(rows.every((r, i) => r[0] === sources[i])).toBe(true);
    const flat = generateTimeOfDayPalette(opts);
    expect(flat).toEqual(rows.flat());
    const groups = timeOfDayRampGroups(rows, "dusk");
    expect(groups.flatMap((g) => g.swatchIndices)).toEqual(flat.map((_, i) => i));
    expect(groups[0].name).toBe("Dusk 1 (#DC2828)");
    expect(groups.every((g) => g.ramp)).toBe(true);
  });

  it("includeSource=false omits the original colour", () => {
    const rows = timeOfDayRows(optsFor("day", { includeSource: false, shadowSteps: 0, highlightSteps: 0 }));
    expect(rows.every((r) => r.length === 1)).toBe(true);
  });

  it("handles an empty source palette", () => {
    expect(generateTimeOfDayPalette(optsFor("dawn", { sourceSwatches: [] }))).toEqual([]);
  });
});
