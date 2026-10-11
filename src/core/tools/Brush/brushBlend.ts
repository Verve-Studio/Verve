/**
 * Paint brush blend modes (Photoshop's brush "Mode").
 *
 * A non-Normal brush paints through the stroke paint layer
 * (`strokeLayer.ts`): every touched pixel is recomposited from its
 * stroke-start value as `blend(original, stroke colour, stroke alpha)`, so
 * a Multiply stroke darkens what was there once instead of compounding
 * with its own overlapping dabs. Separable modes use the W3C compositing
 * formulas, Hue / Saturation / Color / Luminosity the non-separable ones;
 * Behind paints under existing pixels and Clear erases with the brush.
 *
 * The math is mirrored by the WASM kernel (`blend_rgb` / `composite_stroke`
 * in wasm/src/brush_stamp.cpp) — keep the two (and the ids) in sync.
 * Channels are in the layer's value space: sRGB 0..1 for rgba8 (as
 * Photoshop blends 8-bit documents), linear light for rgba32f.
 */

export type BrushBlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity"
  | "behind"
  | "clear";

/** Modes in menu order; the index is the kernel's mode id. */
export const BRUSH_BLEND_MODES: readonly { id: BrushBlendMode; label: string }[] = [
  { id: "normal", label: "Normal" },
  { id: "multiply", label: "Multiply" },
  { id: "screen", label: "Screen" },
  { id: "overlay", label: "Overlay" },
  { id: "darken", label: "Darken" },
  { id: "lighten", label: "Lighten" },
  { id: "color-dodge", label: "Color Dodge" },
  { id: "color-burn", label: "Color Burn" },
  { id: "hard-light", label: "Hard Light" },
  { id: "soft-light", label: "Soft Light" },
  { id: "difference", label: "Difference" },
  { id: "exclusion", label: "Exclusion" },
  { id: "hue", label: "Hue" },
  { id: "saturation", label: "Saturation" },
  { id: "color", label: "Color" },
  { id: "luminosity", label: "Luminosity" },
  { id: "behind", label: "Behind" },
  { id: "clear", label: "Clear" },
];

/** Kernel id of a mode (unknown → Normal). */
export function blendModeId(mode: BrushBlendMode | undefined): number {
  if (mode === undefined) return 0;
  const i = BRUSH_BLEND_MODES.findIndex((m) => m.id === mode);
  return i < 0 ? 0 : i;
}

export const BM_NORMAL = 0;
const BM_MULTIPLY = 1;
const BM_SCREEN = 2;
const BM_OVERLAY = 3;
const BM_DARKEN = 4;
const BM_LIGHTEN = 5;
const BM_COLOR_DODGE = 6;
const BM_COLOR_BURN = 7;
const BM_HARD_LIGHT = 8;
const BM_SOFT_LIGHT = 9;
const BM_DIFFERENCE = 10;
const BM_EXCLUSION = 11;
const BM_HUE = 12;
const BM_SATURATION = 13;
const BM_COLOR = 14;
const BM_LUMINOSITY = 15;
export const BM_BEHIND = 16;
export const BM_CLEAR = 17;

function blendChannel(mode: number, b: number, s: number): number {
  switch (mode) {
    case BM_MULTIPLY:
      return b * s;
    case BM_SCREEN:
      return b + s - b * s;
    case BM_OVERLAY:
      return b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case BM_DARKEN:
      return b < s ? b : s;
    case BM_LIGHTEN:
      return b > s ? b : s;
    case BM_COLOR_DODGE:
      if (b <= 0) return 0;
      if (s >= 1) return 1;
      return Math.min(1, b / (1 - s));
    case BM_COLOR_BURN:
      if (b >= 1) return 1;
      if (s <= 0) return 0;
      return 1 - Math.min(1, (1 - b) / s);
    case BM_HARD_LIGHT:
      return s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case BM_SOFT_LIGHT: {
      if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
      const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(Math.max(0, b));
      return b + (2 * s - 1) * (d - b);
    }
    case BM_DIFFERENCE:
      return Math.abs(b - s);
    case BM_EXCLUSION:
      return b + s - 2 * b * s;
    default:
      return s;
  }
}

const lum = (c: number[]): number => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

function clipColor(c: number[]): void {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  if (n < 0 && l - n > 1e-6) {
    for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * l) / (l - n);
  }
  if (x > 1 && x - l > 1e-6 && l <= 1) {
    for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * (1 - l)) / (x - l);
  }
}

function setLum(c: number[], l: number): void {
  const d = l - lum(c);
  c[0] += d;
  c[1] += d;
  c[2] += d;
  clipColor(c);
}

const sat = (c: number[]): number => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);

function setSat(c: number[], s: number): void {
  const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const mn = c[idx[0]];
  const mx = c[idx[2]];
  if (mx > mn) {
    c[idx[1]] = ((c[idx[1]] - mn) * s) / (mx - mn);
    c[idx[2]] = s;
  } else {
    c[idx[1]] = 0;
    c[idx[2]] = 0;
  }
  c[idx[0]] = 0;
}

const tmp = [0, 0, 0];

/** B(backdrop, source) into `src` (a 3-element array). */
export function blendRgb(mode: number, backdrop: readonly number[], src: number[]): void {
  switch (mode) {
    case BM_HUE:
      tmp[0] = src[0]; tmp[1] = src[1]; tmp[2] = src[2];
      setSat(tmp, sat(backdrop as number[]));
      setLum(tmp, lum(backdrop as number[]));
      break;
    case BM_SATURATION:
      tmp[0] = backdrop[0]; tmp[1] = backdrop[1]; tmp[2] = backdrop[2];
      setSat(tmp, sat(src));
      setLum(tmp, lum(backdrop as number[]));
      break;
    case BM_COLOR:
      tmp[0] = src[0]; tmp[1] = src[1]; tmp[2] = src[2];
      setLum(tmp, lum(backdrop as number[]));
      break;
    case BM_LUMINOSITY:
      tmp[0] = backdrop[0]; tmp[1] = backdrop[1]; tmp[2] = backdrop[2];
      setLum(tmp, lum(src));
      break;
    default:
      src[0] = blendChannel(mode, backdrop[0], src[0]);
      src[1] = blendChannel(mode, backdrop[1], src[1]);
      src[2] = blendChannel(mode, backdrop[2], src[2]);
      return;
  }
  src[0] = tmp[0];
  src[1] = tmp[1];
  src[2] = tmp[2];
}

const mixed = [0, 0, 0];

/**
 * Composite stroke paint (`c`, alpha `as`) over the stroke-start pixel
 * (`b`, alpha `ab`) under `mode` into `out` (unpremultiplied RGBA).
 */
export function compositeStroke(
  mode: number,
  b: readonly number[],
  ab: number,
  c: readonly number[],
  as: number,
  out: number[],
): void {
  let r: number, g: number, bl: number, a: number;
  if (mode === BM_CLEAR) {
    a = ab * (1 - as);
    r = b[0] * a;
    g = b[1] * a;
    bl = b[2] * a;
  } else if (mode === BM_BEHIND) {
    a = ab + as * (1 - ab);
    r = b[0] * ab + c[0] * as * (1 - ab);
    g = b[1] * ab + c[1] * as * (1 - ab);
    bl = b[2] * ab + c[2] * as * (1 - ab);
  } else {
    mixed[0] = c[0];
    mixed[1] = c[1];
    mixed[2] = c[2];
    if (mode !== BM_NORMAL) blendRgb(mode, b, mixed);
    const sOnly = as * (1 - ab);
    const both = as * ab;
    const bOnly = (1 - as) * ab;
    a = as + bOnly;
    r = c[0] * sOnly + mixed[0] * both + b[0] * bOnly;
    g = c[1] * sOnly + mixed[1] * both + b[1] * bOnly;
    bl = c[2] * sOnly + mixed[2] * both + b[2] * bOnly;
  }
  if (a <= 1e-7) {
    out[0] = out[1] = out[2] = out[3] = 0;
    return;
  }
  out[0] = r / a;
  out[1] = g / a;
  out[2] = bl / a;
  out[3] = a;
}
