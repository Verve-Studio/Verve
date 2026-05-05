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

export function sortSwatchesByHue(
  swatches: RGBAColor[],
): Array<{ color: RGBAColor; canonicalIndex: number }> {
  const neutrals: Array<{ color: RGBAColor; canonicalIndex: number }> = [];
  const chromatics: Array<{ color: RGBAColor; canonicalIndex: number }> = [];
  const transparent: Array<{ color: RGBAColor; canonicalIndex: number }> = [];

  for (let i = 0; i < swatches.length; i++) {
    const sw = swatches[i];
    const entry = { color: sw, canonicalIndex: i };
    if (sw.a === 0) {
      transparent.push(entry);
      continue;
    }
    const { s } = rgbaToHsl(sw);
    if (s < 0.15) {
      neutrals.push(entry);
    } else {
      chromatics.push(entry);
    }
  }

  neutrals.sort((a, b) => rgbaToHsl(a.color).l - rgbaToHsl(b.color).l);
  chromatics.sort((a, b) => {
    const ha = rgbaToHsl(a.color);
    const hb = rgbaToHsl(b.color);
    return ha.h !== hb.h ? ha.h - hb.h : ha.l - hb.l;
  });

  return [...chromatics, ...neutrals, ...transparent];
}
