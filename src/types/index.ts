// ─── Tools ────────────────────────────────────────────────────────────────────

export type ShapeType = 'rectangle' | 'ellipse' | 'triangle' | 'line' | 'diamond' | 'star'

export type Tool =
  | 'move'
  | 'select'
  | 'lasso'
  | 'polygonal-selection'
  | 'object-selection'
  | 'magic-wand'
  | 'crop'
  | 'frame'
  | 'eyedropper'
  | 'pencil'
  | 'brush'
  | 'eraser'
  | 'clone-stamp'
  | 'fill'
  | 'gradient'
  | 'dodge'
  | 'burn'
  | 'text'
  | 'shape'
  | 'hand'
  | 'zoom'
  | 'transform'

// ─── Free Transform ───────────────────────────────────────────────────────────

export type TransformInterpolation = 'nearest' | 'bilinear' | 'bicubic'
export type TransformHandleMode   = 'scale' | 'perspective' | 'shear'

export interface TransformParams {
  x: number
  y: number
  w: number
  h: number
  rotation: number
  pivotX: number
  pivotY: number
  shearX: number
  shearY: number
  perspectiveCorners: [Point, Point, Point, Point] | null
}

// ─── Colors ───────────────────────────────────────────────────────────────────

export interface RGBColor {
  r: number
  g: number
  b: number
}

export interface RGBAColor extends RGBColor {
  a: number
}

export interface SwatchGroup {
  id: string
  name: string
  swatchIndices: number[]
}

// ─── Geometry ─────────────────────────────────────────────────────────────────

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect extends Point, Size {}

// ─── SAM / Object Selection ───────────────────────────────────────────────────

export interface PromptPoint {
  x: number
  y: number
  positive: boolean
}

export interface SAMBoundingBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

// ─── State ────────────────────────────────────────────────────────────────────

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'soft-light'
  | 'hard-light'
  | 'darken'
  | 'lighten'
  | 'difference'
  | 'exclusion'
  | 'color-dodge'
  | 'color-burn'
  | 'pass-through'

export interface PixelLayerState {
  id: string
  name: string
  visible: boolean
  opacity: number
  locked: boolean
  blendMode: BlendMode
}

export type TextAlign = 'left' | 'center' | 'right' | 'justify'

export interface TextLayerState {
  id: string
  name: string
  visible: boolean
  opacity: number
  locked: boolean
  blendMode: BlendMode
  type: 'text'
  text: string
  x: number
  y: number
  /** Width of the text bounding box in canvas pixels. 0 = unconstrained. */
  boxWidth: number
  /** Height of the text bounding box in canvas pixels. 0 = unconstrained. */
  boxHeight: number
  fontFamily: string
  fontSize: number
  bold: boolean
  italic: boolean
  underline: boolean
  align: TextAlign
  color: RGBAColor
}

/**
 * Vector shape layer — stores parametric shape data; pixels are rasterized on demand.
 * The bounding-box fields (cx/cy/w/h/rotation) drive all shapes except 'line'.
 * 'line' uses x1/y1/x2/y2 endpoints.
 */
export interface ShapeLayerState {
  id: string
  name: string
  visible: boolean
  opacity: number
  locked: boolean
  blendMode: BlendMode
  type: 'shape'
  shapeType: ShapeType
  /** Center X in canvas pixels (non-line shapes). */
  cx: number
  /** Center Y in canvas pixels (non-line shapes). */
  cy: number
  /** Bounding-box width in canvas pixels (non-line shapes). */
  w: number
  /** Bounding-box height in canvas pixels (non-line shapes). */
  h: number
  /** Rotation in degrees, clockwise (non-line shapes). */
  rotation: number
  /** Line start X (line shape only). */
  x1: number
  /** Line start Y (line shape only). */
  y1: number
  /** Line end X (line shape only). */
  x2: number
  /** Line end Y (line shape only). */
  y2: number
  /** null = no stroke */
  strokeColor: RGBAColor | null
  /** null = no fill */
  fillColor: RGBAColor | null
  strokeWidth: number
  /** Corner radius in canvas pixels. Applies to rectangle. */
  cornerRadius: number
  antiAlias: boolean
}

/**
 * Layer mask child — stores a single-channel grayscale mask (0=hide, 255=show)
 * painted directly on by the user. Stored as a full-canvas RGBA WebGLLayer
 * where the R channel is the mask alpha value.  Immediately follows its parent
 * in the layers array and is excluded from independent compositing.
 */
export interface MaskLayerState {
  id: string
  name: string
  visible: boolean
  type: 'mask'
  /** ID of the parent layer this mask belongs to. */
  parentId: string
}

// ─── Adjustment layers ────────────────────────────────────────────────────────

export type AdjustmentType =
  | 'brightness-contrast'
  | 'hue-saturation'
  | 'color-vibrance'
  | 'color-balance'
  | 'black-and-white'
  | 'color-temperature'
  | 'color-invert'
  | 'selective-color'
  | 'curves'
  | 'color-grading'
  | 'reduce-colors'
  | 'color-dithering'
  | 'bloom'
  | 'chromatic-aberration'
  | 'halation'
  | 'color-key'
  | 'drop-shadow'
  | 'glow'
  | 'outline'
  | 'halftone'
  | 'gaussian-blur'
  | 'box-blur'
  | 'radial-blur'
  | 'motion-blur'
  | 'remove-motion-blur'
  | 'lens-blur'
  | 'sharpen'
  | 'sharpen-more'
  | 'unsharp-mask'
  | 'smart-sharpen'
  | 'add-noise'
  | 'film-grain'
  | 'median-filter'
  | 'bilateral-filter'
  | 'reduce-noise'
  | 'clouds'
  | 'pixelate'

export type FilterKey =
  | 'gaussian-blur'
  | 'box-blur'
  | 'radial-blur'
  | 'motion-blur'
  | 'remove-motion-blur'
  | 'sharpen'
  | 'sharpen-more'
  | 'unsharp-mask'
  | 'smart-sharpen'
  | 'add-noise'
  | 'film-grain'
  | 'lens-blur'
  | 'clouds'
  | 'median-filter'
  | 'bilateral-filter'
  | 'reduce-noise'
  | 'render-lens-flare'
  | 'pixelate'

export type CurvesChannel = 'rgb' | 'red' | 'green' | 'blue'

export interface CurvesControlPoint {
  id: string
  x: number
  y: number
}

export interface CurvesChannelCurve {
  points: CurvesControlPoint[]
}

export interface CurvesVisualAids {
  gridDensity: '4x4' | '8x8'
  showClippingIndicators: boolean
  showReadout: boolean
}

export interface CurvesPresetRef {
  source: 'builtin' | 'custom'
  id: string
  name: string
  dirty: boolean
}

export interface CurvesPreset {
  id: string
  name: string
  channels: Record<CurvesChannel, CurvesChannelCurve>
}

export interface AdjustmentParamsMap {
  'brightness-contrast': { brightness: number; contrast: number }
  'hue-saturation':      { hue: number; saturation: number; lightness: number }
  'color-vibrance':      { vibrance: number; saturation: number }
  'color-balance': {
    shadows:    { cr: number; mg: number; yb: number }
    midtones:   { cr: number; mg: number; yb: number }
    highlights: { cr: number; mg: number; yb: number }
    preserveLuminosity: boolean
  }
  'black-and-white': {
    reds:     number
    yellows:  number
    greens:   number
    cyans:    number
    blues:    number
    magentas: number
  }
  'color-temperature': {
    temperature: number
    tint:        number
  }
  'color-invert': Record<never, never>
  'selective-color': {
    reds:     { cyan: number; magenta: number; yellow: number; black: number }
    yellows:  { cyan: number; magenta: number; yellow: number; black: number }
    greens:   { cyan: number; magenta: number; yellow: number; black: number }
    cyans:    { cyan: number; magenta: number; yellow: number; black: number }
    blues:    { cyan: number; magenta: number; yellow: number; black: number }
    magentas: { cyan: number; magenta: number; yellow: number; black: number }
    whites:   { cyan: number; magenta: number; yellow: number; black: number }
    neutrals: { cyan: number; magenta: number; yellow: number; black: number }
    blacks:   { cyan: number; magenta: number; yellow: number; black: number }
    mode:     'relative' | 'absolute'
  }
  'curves': {
    version: 1
    channels: Record<CurvesChannel, CurvesChannelCurve>
    ui: {
      selectedChannel: CurvesChannel
      visualAids: CurvesVisualAids
      presetRef: CurvesPresetRef | null
    }
  }
  'color-grading': {
    lift:   ColorGradingWheelParams
    gamma:  ColorGradingWheelParams
    gain:   ColorGradingWheelParams
    offset: ColorGradingWheelParams
    temp:      number
    tint:      number
    contrast:  number
    pivot:     number
    midDetail: number
    colorBoost:  number
    shadows:     number
    highlights:  number
    saturation:  number
    hue:         number
    lumMix:      number
  }
  'reduce-colors': {
    mode: 'reduce' | 'palette'
    colorCount: number
    derivedPalette: RGBAColor[] | null
  }
  'color-dithering': {
    style: 'bayer4' | 'bayer8'
    opacity: number
  }
  'bloom': {
    threshold: number
    strength:  number
    spread:    number
    quality:   'full' | 'half' | 'quarter'
  }
  'chromatic-aberration': {
    type:     'radial' | 'directional'
    distance: number   // 0–50 px
    angle:    number   // 0–360 degrees (used only when type === 'directional')
  }
  'halation': {
    threshold: number  // 0–1: luminance level above which halation activates
    spread:    number  // 0–100 px: blur radius
    blur:      number  // 1–5: number of H+V blur iterations (more = softer)
    strength:  number  // 0–1: composite intensity
  }
  'color-key': {
    /** Key color as sRGB bytes (0–255). */
    keyColor:  { r: number; g: number; b: number }
    /** Pixels with HSV distance ≤ tolerance are fully transparent. Range 0–100. */
    tolerance: number
    /** Width of the soft-edge transition zone beyond the tolerance boundary. Range 0–100. */
    softness:  number
    /** Expand the keyed-out region by this many pixels. Range 0–20. */
    dilation:  number
  }
  'drop-shadow': {
    /** Shadow color including alpha channel. r/g/b/a are 0–255. Default: { r:0, g:0, b:0, a:255 } */
    color:     RGBAColor
    /** Overall shadow opacity, 0–100 (%). Applied on top of color.a. Default: 75 */
    opacity:   number
    /** Horizontal offset in canvas pixels, −200 to +200. Default: 5 */
    offsetX:   number
    /** Vertical offset in canvas pixels, −200 to +200. Default: 5 */
    offsetY:   number
    /** Morphological dilation radius in pixels, 0–100. Default: 0 */
    spread:    number
    /** Gaussian blur radius in pixels, 0–100. Default: 10 */
    softness:  number
    /** How the shadow composites with layers beneath it. Default: 'multiply' */
    blendMode: 'normal' | 'multiply' | 'screen'
    /** When true, the shadow is masked by the inverse of the source alpha. Default: true */
    knockout:  boolean
  }
  'glow': {
    /** Glow color including alpha channel. r/g/b/a are 0–255. Default: { r:255, g:255, b:153, a:255 } */
    color:     RGBAColor
    /** Overall glow opacity, 0–100 (%). Applied on top of color.a. Default: 75 */
    opacity:   number
    /** Morphological dilation radius in pixels, 0–100. Default: 0 */
    spread:    number
    /** Gaussian blur radius in pixels, 0–100. Default: 15 */
    softness:  number
    /** How the glow composites with layers beneath it. Default: 'normal' */
    blendMode: 'normal' | 'multiply' | 'screen'
    /** When true, the glow is masked by the inverse of the source alpha (outer glow only). Default: true */
    knockout:  boolean
  }
  'outline': {
    /** Stroke color including alpha. r/g/b/a are 0–255. Default: { r:255, g:0, b:0, a:255 } */
    color:     RGBAColor
    /** Overall stroke opacity, 0–100 (%). Applied on top of color.a. Default: 100 */
    opacity:   number
    /** Stroke width in pixels, 1–100. Integer values only. Default: 3 */
    thickness: number
    /** Controls which side of the silhouette boundary the stroke occupies. Default: 'outside' */
    position:  'outside' | 'inside' | 'center'
    /** Gaussian-approximation blur radius for the stroke mask, 0–50 px. Default: 0 */
    softness:  number
  }
  'halftone': {
    mode:      'color' | 'bw'
    frequency: number
    offsetC:   number
    offsetM:   number
    offsetY:   number
    offsetK:   number
  }
  'gaussian-blur':      { radius: number }
  'box-blur':           { radius: number }
  'radial-blur': {
    mode:    0 | 1
    amount:  number
    centerX: number
    centerY: number
    quality: 0 | 1 | 2
  }
  'motion-blur': { angle: number; distance: number }
  'remove-motion-blur': { angle: number; distance: number; noiseReduction: number }
  'lens-blur': { radius: number; bladeCount: number; bladeCurvature: number; rotation: number }
  'sharpen':      Record<string, never>
  'sharpen-more': Record<string, never>
  'unsharp-mask': { amount: number; radius: number; threshold: number }
  'smart-sharpen': {
    amount:      number
    radius:      number
    reduceNoise: number
    remove:      'gaussian' | 'lens-blur'
  }
  'add-noise': {
    amount:         number
    distribution:   'uniform' | 'gaussian'
    monochromatic:  boolean
    seed:           number
  }
  'film-grain': { grainSize: number; intensity: number; roughness: number; seed: number }
  'median-filter':    { radius: number }
  'bilateral-filter': { radius: number; sigmaSpatial: number; sigmaColor: number }
  'reduce-noise': {
    strength:           number
    preserveDetails:    number
    reduceColorNoise:   number
    sharpenDetails:     number
  }
  'clouds': {
    scale:     number
    opacity:   number
    colorMode: 'grayscale' | 'color'
    fgR: number; fgG: number; fgB: number
    bgR: number; bgG: number; bgB: number
    seed: number
  }
  'pixelate': { blockSize: number }
}

export type OutlineParams = AdjustmentParamsMap['outline']

export interface ColorGradingWheelParams {
  r:      number
  g:      number
  b:      number
  master: number
}

interface AdjustmentLayerBase {
  id:       string
  name:     string
  visible:  boolean
  type:     'adjustment'
  parentId: string
}

export interface BrightnessContrastAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'brightness-contrast'
  params: AdjustmentParamsMap['brightness-contrast']
  /** True when a selection was active at creation time; baked mask pixels live in Canvas adjustmentMaskMap. */
  hasMask: boolean
}

export interface HueSaturationAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'hue-saturation'
  params: AdjustmentParamsMap['hue-saturation']
  /** True when a selection was active at creation time; baked mask pixels live in Canvas adjustmentMaskMap. */
  hasMask: boolean
}

export interface ColorVibranceAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'color-vibrance'
  params: AdjustmentParamsMap['color-vibrance']
  /** True when a selection was active at creation time; baked mask pixels live in Canvas adjustmentMaskMap. */
  hasMask: boolean
}

export interface ColorBalanceAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'color-balance'
  params: AdjustmentParamsMap['color-balance']
  /** True when a selection was active at creation time; the baked mask pixels
   *  live in useCanvas.adjustmentMaskMap (not in React state). */
  hasMask: boolean
}

export interface BlackAndWhiteAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'black-and-white'
  params: AdjustmentParamsMap['black-and-white']
  /** True when a selection was active at creation time; the baked mask pixels
   *  live in useCanvas.adjustmentMaskMap (not in React state). */
  hasMask: boolean
}

export interface ColorTemperatureAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'color-temperature'
  params: AdjustmentParamsMap['color-temperature']
  /** True when a selection was active at creation time; the baked mask pixels
   *  live in useCanvas.adjustmentMaskMap (not in React state). */
  hasMask: boolean
}

export interface ColorInvertAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'color-invert'
  params: AdjustmentParamsMap['color-invert']
  /** True when a selection was active at creation time; the baked mask pixels
   *  live in useCanvas.adjustmentMaskMap (not in React state). */
  hasMask: boolean
}

export interface SelectiveColorAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'selective-color'
  params: AdjustmentParamsMap['selective-color']
  /** True when a selection was active at creation time; the baked mask pixels
   *  live in useCanvas.adjustmentMaskMap (not in React state). */
  hasMask: boolean
}

export interface CurvesAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'curves'
  params: AdjustmentParamsMap['curves']
  /** True when a selection was active at creation time; the baked mask pixels
   *  live in useCanvas.adjustmentMaskMap (not in React state). */
  hasMask: boolean
}

export interface ColorGradingAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'color-grading'
  params: AdjustmentParamsMap['color-grading']
  /** True when a selection was active at creation time; baked mask pixels live
   *  in Canvas adjustmentMaskMap, not in React state. */
  hasMask: boolean
}

export interface ReduceColorsAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'reduce-colors'
  params: AdjustmentParamsMap['reduce-colors']
  hasMask: boolean
}

export interface ColorDitheringAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'color-dithering'
  params: AdjustmentParamsMap['color-dithering']
  hasMask: boolean
}

export interface BloomAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'bloom'
  params: AdjustmentParamsMap['bloom']
  hasMask: boolean
}

export interface ChromaticAberrationAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'chromatic-aberration'
  params: AdjustmentParamsMap['chromatic-aberration']
  hasMask: boolean
}

export interface HalationAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'halation'
  params: AdjustmentParamsMap['halation']
  hasMask: boolean
}

export interface ColorKeyAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'color-key'
  params: AdjustmentParamsMap['color-key']
  hasMask: boolean
}

export interface DropShadowAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'drop-shadow'
  params: AdjustmentParamsMap['drop-shadow']
  hasMask: boolean
}

export interface GlowAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'glow'
  params: AdjustmentParamsMap['glow']
  hasMask: boolean
}

export interface OutlineAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'outline'
  params: AdjustmentParamsMap['outline']
  hasMask: boolean
}

export interface HalftoneAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'halftone'
  params: AdjustmentParamsMap['halftone']
  hasMask: boolean
}

export interface GaussianBlurAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'gaussian-blur'
  params: AdjustmentParamsMap['gaussian-blur']
  hasMask: boolean
}

export interface BoxBlurAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'box-blur'
  params: AdjustmentParamsMap['box-blur']
  hasMask: boolean
}

export interface RadialBlurAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'radial-blur'
  params: AdjustmentParamsMap['radial-blur']
  hasMask: boolean
}

export interface MotionBlurAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'motion-blur'
  params: AdjustmentParamsMap['motion-blur']
  hasMask: boolean
}

export interface RemoveMotionBlurAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'remove-motion-blur'
  params: AdjustmentParamsMap['remove-motion-blur']
  hasMask: boolean
}

export interface LensBlurAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'lens-blur'
  params: AdjustmentParamsMap['lens-blur']
  hasMask: boolean
}

export interface SharpenAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'sharpen'
  params: AdjustmentParamsMap['sharpen']
  hasMask: boolean
}

export interface SharpenMoreAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'sharpen-more'
  params: AdjustmentParamsMap['sharpen-more']
  hasMask: boolean
}

export interface UnsharpMaskAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'unsharp-mask'
  params: AdjustmentParamsMap['unsharp-mask']
  hasMask: boolean
}

export interface SmartSharpenAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'smart-sharpen'
  params: AdjustmentParamsMap['smart-sharpen']
  hasMask: boolean
}

export interface AddNoiseAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'add-noise'
  params: AdjustmentParamsMap['add-noise']
  hasMask: boolean
}

export interface FilmGrainAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'film-grain'
  params: AdjustmentParamsMap['film-grain']
  hasMask: boolean
}

export interface MedianFilterAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'median-filter'
  params: AdjustmentParamsMap['median-filter']
  hasMask: boolean
}

export interface BilateralFilterAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'bilateral-filter'
  params: AdjustmentParamsMap['bilateral-filter']
  hasMask: boolean
}

export interface ReduceNoiseAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'reduce-noise'
  params: AdjustmentParamsMap['reduce-noise']
  hasMask: boolean
}

export interface CloudsAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'clouds'
  params: AdjustmentParamsMap['clouds']
  hasMask: boolean
}

export interface PixelateAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'pixelate'
  params: AdjustmentParamsMap['pixelate']
  hasMask: boolean
}

export type AdjustmentLayerState =
  | BrightnessContrastAdjustmentLayer
  | HueSaturationAdjustmentLayer
  | ColorVibranceAdjustmentLayer
  | ColorBalanceAdjustmentLayer
  | BlackAndWhiteAdjustmentLayer
  | ColorTemperatureAdjustmentLayer
  | ColorInvertAdjustmentLayer
  | SelectiveColorAdjustmentLayer
  | CurvesAdjustmentLayer
  | ColorGradingAdjustmentLayer
  | ReduceColorsAdjustmentLayer
  | ColorDitheringAdjustmentLayer
  | BloomAdjustmentLayer
  | ChromaticAberrationAdjustmentLayer
  | HalationAdjustmentLayer
  | ColorKeyAdjustmentLayer
  | DropShadowAdjustmentLayer
  | GlowAdjustmentLayer
  | OutlineAdjustmentLayer
  | HalftoneAdjustmentLayer
  | GaussianBlurAdjustmentLayer
  | BoxBlurAdjustmentLayer
  | RadialBlurAdjustmentLayer
  | MotionBlurAdjustmentLayer
  | RemoveMotionBlurAdjustmentLayer
  | LensBlurAdjustmentLayer
  | SharpenAdjustmentLayer
  | SharpenMoreAdjustmentLayer
  | UnsharpMaskAdjustmentLayer
  | SmartSharpenAdjustmentLayer
  | AddNoiseAdjustmentLayer
  | FilmGrainAdjustmentLayer
  | MedianFilterAdjustmentLayer
  | BilateralFilterAdjustmentLayer
  | ReduceNoiseAdjustmentLayer
  | CloudsAdjustmentLayer
  | PixelateAdjustmentLayer

export interface GroupLayerState {
  id:        string
  name:      string
  visible:   boolean
  opacity:   number
  locked:    boolean
  blendMode: BlendMode
  type:      'group'
  collapsed: boolean
  childIds:  string[]
}

export type LayerState = PixelLayerState | TextLayerState | ShapeLayerState | MaskLayerState | AdjustmentLayerState | GroupLayerState

export function isGroupLayer(l: LayerState): l is GroupLayerState {
  return 'type' in l && l.type === 'group'
}

export function isPixelLayer(l: LayerState): l is PixelLayerState {
  return !('type' in l)
}

export type BackgroundFill = 'white' | 'black' | 'transparent'

export type GridType = 'normal' | 'thirds' | 'safe-zone'

export interface CanvasState {
  width: number
  height: number
  zoom: number
  panX: number
  panY: number
  showGrid: boolean
  gridSize: number
  gridColor: string
  gridType: GridType
  backgroundFill: BackgroundFill
  key: number
  tiledMode: boolean
  showTileGrid: boolean
}

// ─── Pixel Brushes ─────────────────────────────────────────────────────────────

/**
 * A custom pixel-art brush captured from a canvas selection.
 * `rgba` holds the raw RGBA bytes (width × height × 4) encoded as a base64 string.
 * Transparent pixels in the brush mask (a === 0) are skipped when stamping.
 */
export interface PixelBrush {
  id: string
  name: string
  width: number
  height: number
  /** Raw RGBA bytes, width × height × 4, base64-encoded. */
  rgba: string
  createdAt: number
}

export type PixelFormat = 'rgba8' | 'rgba32f' | 'indexed8'

export interface AppState {
  activeTool: Tool
  activeShape: ShapeType
  primaryColor: RGBAColor
  secondaryColor: RGBAColor
  swatches: RGBAColor[]
  swatchGroups: SwatchGroup[]
  /** Pixel brushes stored with this document (travel with the .pxshop file). */
  pixelBrushes: PixelBrush[]
  layers: LayerState[]
  activeLayerId: string | null
  /** Layer IDs ctrl/cmd-clicked in the Layers panel for multi-selection operations. */
  selectedLayerIds: string[]
  canvas: CanvasState
  history: {
    canUndo: boolean
    canRedo: boolean
  }
  openAdjustmentLayerId: string | null
  pixelFormat: PixelFormat
}
