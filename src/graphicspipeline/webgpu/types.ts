import type { AdjustmentParamsMap } from '@/types'
import type { CurvesLuts } from '@/core/operations/adjustments/curves'

// ─── Param type aliases ────────────────────────────────────────────────────────

export type ColorBalancePassParams   = AdjustmentParamsMap['color-balance']
export type BlackAndWhitePassParams  = AdjustmentParamsMap['black-and-white']
export type SelectiveColorPassParams = AdjustmentParamsMap['selective-color']
export type CurvesPassParams         = AdjustmentParamsMap['curves']
export type ColorGradingPassParams   = AdjustmentParamsMap['color-grading']

// ─── GpuLayer ─────────────────────────────────────────────────────────────────

export interface GpuLayer {
  id: string
  name: string
  texture: GPUTexture
  data: Uint8Array
  layerWidth: number
  layerHeight: number
  offsetX: number
  offsetY: number
  opacity: number
  visible: boolean
  blendMode: string
  /** Accumulated dirty region in layer-local texel coords. Expanded by tools; consumed + reset by flushLayer. */
  dirtyRect: { lx: number; ly: number; rx: number; ry: number } | null
}

export const BLEND_MODE_INDEX: Record<string, number> = {
  'normal': 0, 'multiply': 1, 'screen': 2, 'overlay': 3,
  'soft-light': 4, 'hard-light': 5, 'darken': 6, 'lighten': 7,
  'difference': 8, 'exclusion': 9, 'color-dodge': 10, 'color-burn': 11,
}

// ─── AdjustmentRenderOp ───────────────────────────────────────────────────────

export type AdjustmentRenderOp =
  | { kind: 'brightness-contrast'; layerId: string; brightness: number; contrast: number; visible: boolean; selMaskLayer?: GpuLayer }
  | { kind: 'hue-saturation'; layerId: string; hue: number; saturation: number; lightness: number; visible: boolean; selMaskLayer?: GpuLayer }
  | { kind: 'color-vibrance'; layerId: string; vibrance: number; saturation: number; visible: boolean; selMaskLayer?: GpuLayer }
  | { kind: 'color-balance'; layerId: string; params: ColorBalancePassParams; visible: boolean; selMaskLayer?: GpuLayer }
  | { kind: 'black-and-white'; layerId: string; params: BlackAndWhitePassParams; visible: boolean; selMaskLayer?: GpuLayer }
  | { kind: 'color-temperature'; layerId: string; temperature: number; tint: number; visible: boolean; selMaskLayer?: GpuLayer }
  | { kind: 'color-invert'; layerId: string; visible: boolean; selMaskLayer?: GpuLayer }
  | { kind: 'selective-color'; layerId: string; params: SelectiveColorPassParams; visible: boolean; selMaskLayer?: GpuLayer }
  | { kind: 'curves'; layerId: string; params: CurvesPassParams; luts: CurvesLuts; visible: boolean; selMaskLayer?: GpuLayer }
  | { kind: 'color-grading'; layerId: string; params: ColorGradingPassParams; visible: boolean; selMaskLayer?: GpuLayer }
  | {
      kind: 'reduce-colors'
      layerId: string
      visible: boolean
      selMaskLayer?: GpuLayer
      palette: Float32Array
      paletteCount: number
    }
  | {
      kind: 'color-dithering'
      layerId: string
      visible: boolean
      selMaskLayer?: GpuLayer
      palette: Float32Array
      paletteCount: number
      style: number  // 0=bayer4, 1=bayer8
      opacity: number
    }
  | {
      kind: 'bloom'
      layerId:   string
      threshold: number
      strength:  number
      spread:    number
      quality:   'full' | 'half' | 'quarter'
      visible:   boolean
      selMaskLayer?: GpuLayer
    }
  | {
      kind:     'chromatic-aberration'
      layerId:  string
      caType:   'radial' | 'directional'
      distance: number
      angle:    number
      visible:  boolean
      selMaskLayer?: GpuLayer
    }
  | {
      kind:      'halation'
      layerId:   string
      threshold: number
      spread:    number
      blur:      number
      strength:  number
      visible:   boolean
      selMaskLayer?: GpuLayer
    }
  | {
      kind:      'color-key'
      layerId:   string
      /** Key color components pre-normalised to 0..1. */
      keyR:      number
      keyG:      number
      keyB:      number
      tolerance: number    // 0..100
      softness:  number    // 0..100
      dilation:  number    // 0..20 px
      visible:   boolean
      selMaskLayer?: GpuLayer
    }
  | {
      kind:      'drop-shadow'
      layerId:   string
      /** Shadow color components pre-normalised to 0..1. */
      colorR:    number
      colorG:    number
      colorB:    number
      colorA:    number    // 0..1 (color.a / 255)
      opacity:   number    // 0..1 (pre-divided by 100)
      offsetX:   number    // signed pixels
      offsetY:   number    // signed pixels
      spread:    number    // 0..100 px
      softness:  number    // 0..100 px
      blendMode: 'normal' | 'multiply' | 'screen'
      knockout:  boolean
      visible:   boolean
      selMaskLayer?: GpuLayer
    }
  | {
      kind:      'glow'
      layerId:   string
      /** Glow color components pre-normalised to 0..1. */
      colorR:    number
      colorG:    number
      colorB:    number
      colorA:    number    // 0..1 (color.a / 255)
      opacity:   number    // 0..1 (pre-divided by 100)
      spread:    number    // 0..100 px
      softness:  number    // 0..100 px
      blendMode: 'normal' | 'multiply' | 'screen'
      knockout:  boolean
      visible:   boolean
      selMaskLayer?: GpuLayer
    }
  | {
      kind:      'outline'
      layerId:   string
      /** Stroke color components pre-normalised to 0..1. */
      colorR:    number
      colorG:    number
      colorB:    number
      colorA:    number    // 0..1 (color.a / 255)
      opacity:   number    // 0..1 (pre-divided by 100)
      thickness: number    // integer 1..100 px
      position:  'outside' | 'inside' | 'center'
      softness:  number    // 0..50 px
      visible:   boolean
      selMaskLayer?: GpuLayer
    }
  | {
      kind:      'halftone'
      layerId:   string
      frequency: number         // 2–50 cells per 100 px
      offsetC:   number         // −50..+50 (%)
      offsetM:   number
      offsetY:   number
      offsetK:   number
      mode:      'color' | 'bw'
      visible:   boolean
      selMaskLayer?: GpuLayer
    }

// ─── RenderPlanEntry ──────────────────────────────────────────────────────────

export type RenderPlanEntry =
  | { kind: 'layer'; layer: GpuLayer; mask?: GpuLayer }
  | {
      kind: 'adjustment-group'
      parentLayerId: string
      baseLayer: GpuLayer
      baseMask?: GpuLayer
      adjustments: AdjustmentRenderOp[]
    }
  | {
      kind: 'layer-group'
      groupId:   string
      opacity:   number
      blendMode: string
      visible:   boolean
      children:  RenderPlanEntry[]
    }
  | AdjustmentRenderOp

// ─── Error ────────────────────────────────────────────────────────────────────

export class WebGPUUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebGPUUnavailableError'
  }
}
