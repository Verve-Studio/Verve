import { RGBAColor } from "@/types";

export function rgbaToHsl(c: RGBAColor): { h: number; s: number; l: number } {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return { h: 0, s: 0, l };

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h: number;
  switch (max) {
    case r:
      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      break;
    case g:
      h = ((b - r) / d + 2) / 6;
      break;
    default:
      h = ((r - g) / d + 4) / 6;
      break;
  }

  return { h: h * 360, s, l };
}

/** RGB(A) → HSV (h: 0–360, s: 0–1, v: 0–1).  Used by the Photoshop sort. */
function rgbaToHsv(c: RGBAColor): { h: number; s: number; v: number } {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  if (d === 0) return { h: 0, s, v };
  let h: number;
  switch (max) {
    case r:
      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      break;
    case g:
      h = ((b - r) / d + 2) / 6;
      break;
    default:
      h = ((r - g) / d + 4) / 6;
      break;
  }
  return { h: h * 360, s, v };
}

/**
 * Photoshop "Sort Swatches by Hue".  Adobe groups colours into chromatic
 * vs achromatic, sorts each group separately, then concatenates:
 *
 *   1. Achromatic ("greys") with saturation below a small threshold:
 *      sorted by brightness (V) ascending — black first, white last.
 *   2. Chromatic colours: sorted by HSV hue ascending (so the rainbow walks
 *      red → yellow → green → cyan → blue → magenta), tie-broken first by
 *      saturation descending (more vivid before more muted at the same hue)
 *      and finally by brightness ascending.
 *   3. Fully transparent slots sink to the very end.
 *
 * No hue bucketing — adjacent hues stay strictly ordered, which is what
 * users mean when they ask for "Photoshop sort".
 */
export function sortSwatchesByHue(
  swatches: RGBAColor[],
): Array<{ color: RGBAColor; canonicalIndex: number }> {
  type Entry = {
    color: RGBAColor;
    canonicalIndex: number;
    h: number;
    s: number;
    v: number;
  };
  const ACHROMATIC_SATURATION = 0.05;

  const achromatic: Entry[] = [];
  const chromatic: Entry[] = [];
  const transparent: Entry[] = [];

  for (let i = 0; i < swatches.length; i++) {
    const sw = swatches[i];
    if (sw.a === 0) {
      transparent.push({ color: sw, canonicalIndex: i, h: 0, s: 0, v: 0 });
      continue;
    }
    const { h, s, v } = rgbaToHsv(sw);
    const entry: Entry = { color: sw, canonicalIndex: i, h, s, v };
    if (s < ACHROMATIC_SATURATION) achromatic.push(entry);
    else chromatic.push(entry);
  }

  achromatic.sort((a, b) => a.v - b.v);
  chromatic.sort((a, b) => {
    if (a.h !== b.h) return a.h - b.h;
    if (a.s !== b.s) return b.s - a.s;
    return a.v - b.v;
  });

  return [...achromatic, ...chromatic, ...transparent].map((e) => ({
    color: e.color,
    canonicalIndex: e.canonicalIndex,
  }));
}

// ─── Palette deduplication helpers ───────────────────────────────────────────

/**
 * Drop any colour that exactly matches an already-kept entry (same r/g/b/a
 * bytes).  Stable: the first occurrence of each unique colour wins.
 */
export function dedupeSwatchesByRgba(
  colors: readonly RGBAColor[],
): RGBAColor[] {
  const seen = new Set<number>();
  const out: RGBAColor[] = [];
  for (const c of colors) {
    const key = (c.r << 24) | (c.g << 16) | (c.b << 8) | c.a;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Greedy-merge colours within `threshold` Euclidean distance in 0–255 RGB
 * space.  Iterates the input in order; each colour either joins an
 * already-kept entry (if a near-match is found) or becomes a new kept entry.
 * Alpha is compared exactly so transparent slots stay distinct from opaque
 * ones.
 *
 * Used after median-cut quantisation: a flat-colour image is split into
 * `maxColors` buckets, but most buckets average to near-identical colours
 * (band centres + a few anti-aliased boundary pixels).  Without this merge
 * the preview reports e.g. "7 colours" for an image that has 4 visually
 * distinct bands.
 */
export function mergeNearbySwatches(
  colors: readonly RGBAColor[],
  threshold: number,
): RGBAColor[] {
  const out: RGBAColor[] = [];
  const t2 = threshold * threshold;
  for (const c of colors) {
    let merged = false;
    for (const k of out) {
      if (c.a !== k.a) continue;
      const dr = c.r - k.r;
      const dg = c.g - k.g;
      const db = c.b - k.b;
      if (dr * dr + dg * dg + db * db <= t2) {
        merged = true;
        break;
      }
    }
    if (!merged) out.push(c);
  }
  return out;
}

/**
 * One-stop normaliser for an extracted palette: drops exact duplicates,
 * merges perceptually-near colours, then applies the standard hue-bucket
 * sort.  Use this anywhere you want the canonical "Photoshop-style" palette
 * presentation so every call site stays consistent.
 *
 * `mergeThreshold` defaults to 0 (no perceptual merge) so callers that just
 * want the bare dedup+sort behaviour don't need to pass anything; pass a
 * small positive value (e.g. 20) for image-extracted palettes that may
 * contain anti-aliased boundary pixels.
 */
export function normalizePaletteForDisplay(
  colors: readonly RGBAColor[],
  mergeThreshold = 0,
): RGBAColor[] {
  let out = dedupeSwatchesByRgba(colors);
  if (mergeThreshold > 0) out = mergeNearbySwatches(out, mergeThreshold);
  return sortSwatchesByHue(out).map((e) => e.color);
}
