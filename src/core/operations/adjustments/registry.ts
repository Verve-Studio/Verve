import type { AdjustmentType, AdjustmentParamsMap } from '@/types'
import { createDefaultCurvesParams } from '@/core/operations/adjustments/curves'

export interface AdjustmentRegistrationEntry<T extends AdjustmentType = AdjustmentType> {
  adjustmentType: T
  label: string
  defaultParams: AdjustmentParamsMap[T]
  group?: string
}

export const ADJUSTMENT_REGISTRY = [
  {
    adjustmentType: 'brightness-contrast' as const,
    label: 'Brightness/Contrast…',
    defaultParams: { brightness: 0, contrast: 0 },
    group: 'color-adjustments',
  },
  {
    adjustmentType: 'hue-saturation' as const,
    label: 'Hue/Saturation…',
    defaultParams: { hue: 0, saturation: 0, lightness: 0 },
    group: 'color-adjustments',
  },
  {
    adjustmentType: 'color-vibrance' as const,
    label: 'Color Vibrance…',
    defaultParams: { vibrance: 0, saturation: 0 },
    group: 'color-adjustments',
  },
  {
    adjustmentType: 'color-balance' as const,
    label: 'Color Balance…',
    defaultParams: {
      shadows:    { cr: 0, mg: 0, yb: 0 },
      midtones:   { cr: 0, mg: 0, yb: 0 },
      highlights: { cr: 0, mg: 0, yb: 0 },
      preserveLuminosity: true,
    },
    group: 'color-adjustments',
  },
  {
    adjustmentType: 'black-and-white' as const,
    label: 'Black and White…',
    defaultParams: {
      reds:     40,
      yellows:  60,
      greens:   40,
      cyans:    60,
      blues:    20,
      magentas: 80,
    },
    group: 'color-adjustments',
  },
  {
    adjustmentType: 'color-temperature' as const,
    label: 'Color Temperature…',
    defaultParams: { temperature: 0, tint: 0 },
    group: 'color-adjustments',
  },
  {
    adjustmentType: 'color-invert' as const,
    label: 'Invert',
    defaultParams: {},
    group: 'color-adjustments',
  },
  {
    adjustmentType: 'selective-color' as const,
    label: 'Selective Color…',
    defaultParams: {
      reds:     { cyan: 0, magenta: 0, yellow: 0, black: 0 },
      yellows:  { cyan: 0, magenta: 0, yellow: 0, black: 0 },
      greens:   { cyan: 0, magenta: 0, yellow: 0, black: 0 },
      cyans:    { cyan: 0, magenta: 0, yellow: 0, black: 0 },
      blues:    { cyan: 0, magenta: 0, yellow: 0, black: 0 },
      magentas: { cyan: 0, magenta: 0, yellow: 0, black: 0 },
      whites:   { cyan: 0, magenta: 0, yellow: 0, black: 0 },
      neutrals: { cyan: 0, magenta: 0, yellow: 0, black: 0 },
      blacks:   { cyan: 0, magenta: 0, yellow: 0, black: 0 },
      mode: 'relative',
    },
    group: 'color-adjustments',
  },
  {
    adjustmentType: 'curves' as const,
    label: 'Curves…',
    defaultParams: createDefaultCurvesParams(),
    group: 'color-adjustments',
  },
  {
    adjustmentType: 'color-grading' as const,
    label: 'Color Grading…',
    defaultParams: {
      lift:   { r: 0, g: 0, b: 0, master: 0 },
      gamma:  { r: 0, g: 0, b: 0, master: 0 },
      gain:   { r: 0, g: 0, b: 0, master: 0 },
      offset: { r: 0, g: 0, b: 0, master: 0 },
      temp:      6500,
      tint:      0,
      contrast:  1.0,
      pivot:     0.435,
      midDetail: 0,
      colorBoost:  0,
      shadows:     0,
      highlights:  0,
      saturation:  50,
      hue:         50,
      lumMix:      100,
    },
    group: 'color-adjustments',
  },
  {
    adjustmentType: 'reduce-colors' as const,
    label: 'Reduce Colors…',
    defaultParams: { mode: 'reduce', colorCount: 16, derivedPalette: null },
    group: 'color-adjustments',
  },
  {
    adjustmentType: 'color-dithering' as const,
    label: 'Color Dithering…',
    defaultParams: { style: 'bayer4' as const, opacity: 100 },
    group: 'color-adjustments',
  },
  {
    adjustmentType: 'bloom' as const,
    label: 'Bloom…',
    group: 'real-time-effects',
    defaultParams: {
      threshold: 0.5,
      strength:  0.5,
      spread:    20,
      quality:   'half',
    },
  },
  {
    adjustmentType: 'chromatic-aberration' as const,
    label: 'Chromatic Aberration…',
    group: 'real-time-effects',
    defaultParams: {
      type:     'radial',
      distance: 5,
      angle:    0,
    },
  },
  {
    adjustmentType: 'halation' as const,
    label: 'Halation…',
    group: 'real-time-effects',
    defaultParams: {
      threshold: 0.5,
      spread:    30,
      blur:      2,
      strength:  0.6,
    },
  },
  {
    adjustmentType: 'color-key' as const,
    label: 'Color Key…',
    defaultParams: { keyColor: { r: 0, g: 255, b: 0 }, tolerance: 0, softness: 0, dilation: 0 },
    group: 'real-time-effects',
  },
  {
    adjustmentType: 'drop-shadow' as const,
    label: 'Drop Shadow…',
    group: 'real-time-effects',
    defaultParams: {
      color:     { r: 0, g: 0, b: 0, a: 255 },
      opacity:   75,
      offsetX:   5,
      offsetY:   5,
      spread:    0,
      softness:  10,
      blendMode: 'multiply',
      knockout:  true,
    },
  },
  {
    adjustmentType: 'glow' as const,
    label: 'Glow…',
    group: 'real-time-effects',
    defaultParams: {
      color:     { r: 255, g: 255, b: 153, a: 255 },
      opacity:   75,
      spread:    0,
      softness:  15,
      blendMode: 'normal',
      knockout:  true,
    },
  },
  {
    adjustmentType: 'outline' as const,
    label: 'Outline…',
    group: 'real-time-effects',
    defaultParams: {
      color:     { r: 255, g: 0, b: 0, a: 255 },
      opacity:   100,
      thickness: 3,
      position:  'outside',
      softness:  0,
    },
  },
  {
    adjustmentType: 'halftone' as const,
    label: 'Halftone…',
    group: 'real-time-effects',
    defaultParams: {
      mode:      'color' as const,
      frequency: 10,
      offsetC:   0,
      offsetM:   0,
      offsetY:   0,
      offsetK:   0,
    },
  },
] as const satisfies readonly AdjustmentRegistrationEntry[]
