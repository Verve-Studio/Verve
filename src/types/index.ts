// ─── Tools ────────────────────────────────────────────────────────────────────

export type ShapeType =
  | "rectangle"
  | "ellipse"
  | "triangle"
  | "line"
  | "diamond"
  | "star";

export type FrameType = "rectangle" | "ellipse";

/**
 * How content is fitted within a frame's bounding box.
 * - 'fill'     — cover: scale uniformly so the content fully covers the frame; crop overflow.
 * - 'fit'      — contain: scale uniformly so the content fits inside the frame; letterbox.
 * - 'stretch'  — non-uniform scale to exactly match frame dimensions.
 * - 'center'   — no scaling; content is centred at native size and clipped.
 */
export type FrameContentFit = "fill" | "fit" | "stretch" | "center";

export type Tool =
  | "move"
  | "pick"
  | "select"
  | "lasso"
  | "polygonal-selection"
  | "object-selection"
  | "quick-select"
  | "magic-wand"
  | "crop"
  | "frame"
  | "eyedropper"
  | "pencil"
  | "brush"
  | "eraser"
  | "clone-stamp"
  | "fill"
  | "gradient"
  | "dodge"
  | "burn"
  | "text"
  | "shape"
  | "liquify"
  | "blur"
  | "sharpen"
  | "smudge"
  | "patch"
  | "healing-brush"
  | "measure"
  | "hand"
  | "zoom"
  | "transform";

// ─── Free Transform ───────────────────────────────────────────────────────────

export type TransformInterpolation = "nearest" | "bilinear" | "bicubic";
export type TransformHandleMode = "scale" | "perspective" | "shear";

export interface TransformParams {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  pivotX: number;
  pivotY: number;
  shearX: number;
  shearY: number;
  perspectiveCorners: [Point, Point, Point, Point] | null;
}

// ─── Colors ───────────────────────────────────────────────────────────────────

export interface RGBColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Generic RGBA color. Semantics depend on context:
 * - `AppState.primaryColor` / `secondaryColor`: r/g/b are floats in [0,∞) (>1 = HDR), a ∈ [0,1].
 * - Swatches, text/shape/adjustment colors: r/g/b/a are integers in [0,255].
 */
export interface RGBAColor extends RGBColor {
  a: number;
}

export interface SwatchGroupCycle {
  /** When true, this group's colours rotate through their slots while the
   *  palette animation is running. */
  enabled: boolean;
  /** How many slots to advance every `ticksPerStep` palette ticks.
   *  Negative values cycle backwards. */
  stepsPerStep: number;
  /** How many palette-animation ticks to wait between advances. 1 = every
   *  tick. */
  ticksPerStep: number;
}

export interface SwatchGroup {
  id: string;
  name: string;
  swatchIndices: number[];
  /** Optional palette-animation cycle configuration. Absent on groups that
   *  have never been touched by the palette-animation panel. */
  cycle?: SwatchGroupCycle;
}

export interface PaletteAnimationState {
  /** When true, the palette-cycle pre-pass is applied to the displayed
   *  indexed8 canvas. Mutually exclusive with `spritesheet.enabled`. */
  enabled: boolean;
  /** Cycle ticks per second. */
  fps: number;
}

// ─── Geometry ─────────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

// ─── SAM / Object Selection ───────────────────────────────────────────────────

export interface PromptPoint {
  x: number;
  y: number;
  positive: boolean;
}

export interface SAMBoundingBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// ─── State ────────────────────────────────────────────────────────────────────

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "soft-light"
  | "hard-light"
  | "darken"
  | "lighten"
  | "difference"
  | "exclusion"
  | "color-dodge"
  | "color-burn"
  | "pass-through";

/** Colour-space tag for a pixel layer. Drives an IDT pre-pass in the renderer
 *  that decodes the layer's stored values into the document's working space
 *  before any adjustment / composite runs.
 *
 *  - `'auto'` (default) — use the document working space directly:
 *      • rgba8 / indexed8 docs → sRGB-encoded display values
 *      • rgba32f docs → scene-linear sRGB primaries
 *    No pre-pass; existing behaviour preserved.
 *  - `'srgb'` / `'linear-srgb'` — explicit non-default tags.
 *  - `'slog3'` … `'apple-log'` — camera log encodings. The renderer applies
 *    the matching built-in IDT (vendor inverse OETF + gamut → sRGB) before
 *    the layer enters the composite. This is the "input transform" stage. */
export type LayerColorSpace =
  | "auto"
  | "srgb"
  | "linear-srgb"
  | "slog3"
  | "logc3"
  | "vlog"
  | "red-log3g10"
  | "clog3"
  | "apple-log"
  | "aces-cg";

export interface PixelLayerState {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  locked: boolean;
  blendMode: BlendMode;
  /** Colour-space tag; `undefined` is treated as `'auto'`. Stored on
   *  `PixelLayerState` only — generative layer types (text, shape, frame,
   *  effect) emit pixels already in the document working space. */
  colorSpace?: LayerColorSpace;
}

export type TextAlign = "left" | "center" | "right" | "justify";

export interface TextLayerState {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  locked: boolean;
  blendMode: BlendMode;
  type: "text";
  text: string;
  x: number;
  y: number;
  /** Width of the text bounding box in canvas pixels. 0 = unconstrained. */
  boxWidth: number;
  /** Height of the text bounding box in canvas pixels. 0 = unconstrained. */
  boxHeight: number;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  align: TextAlign;
  letterSpacing: number; // canvas pixels; 0 = no extra tracking
  lineHeight: number; // em multiplier; default 1.2
  kerning: "auto" | "none";
  color: RGBAColor;
}

/**
 * Vector shape layer — stores parametric shape data; pixels are rasterized on demand.
 * The bounding-box fields (cx/cy/w/h/rotation) drive all shapes except 'line'.
 * 'line' uses x1/y1/x2/y2 endpoints.
 */
export interface ShapeLayerState {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  locked: boolean;
  blendMode: BlendMode;
  type: "shape";
  shapeType: ShapeType;
  /** Center X in canvas pixels (non-line shapes). */
  cx: number;
  /** Center Y in canvas pixels (non-line shapes). */
  cy: number;
  /** Bounding-box width in canvas pixels (non-line shapes). */
  w: number;
  /** Bounding-box height in canvas pixels (non-line shapes). */
  h: number;
  /** Rotation in degrees, clockwise (non-line shapes). */
  rotation: number;
  /** Line start X (line shape only). */
  x1: number;
  /** Line start Y (line shape only). */
  y1: number;
  /** Line end X (line shape only). */
  x2: number;
  /** Line end Y (line shape only). */
  y2: number;
  /** null = no stroke */
  strokeColor: RGBAColor | null;
  /** null = no fill */
  fillColor: RGBAColor | null;
  /** Optional palette index reference (indexed8 docs). When set, the
   *  shape rasterises using the *current* `state.swatches[strokeIndex]`
   *  colour instead of the cached `strokeColor`, so palette edits and
   *  swap-style cycling live-update the shape. */
  strokeIndex?: number;
  /** Same as `strokeIndex` for the fill colour. */
  fillIndex?: number;
  strokeWidth: number;
  /** Corner radius in canvas pixels. Applies to rectangle. */
  cornerRadius: number;
  antiAlias: boolean;
}

/**
 * Frame layer — a parametric clipping container, like Photoshop's Frame Tool.
 * The frame defines a rectangular or elliptical region into which an image
 * (or future content) is fitted and clipped. When `content` is null the frame
 * renders an empty placeholder and acts as a target for image drops.
 */
export interface FrameLayerState {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  locked: boolean;
  blendMode: BlendMode;
  type: "frame";
  frameType: FrameType;
  /** Bounding box centre X (canvas pixels). */
  cx: number;
  /** Bounding box centre Y (canvas pixels). */
  cy: number;
  /** Bounding box width (canvas pixels). */
  w: number;
  /** Bounding box height (canvas pixels). */
  h: number;
  /** Rotation in degrees, clockwise. */
  rotation: number;
  /**
   * Content image, or null for an empty frame.
   * `rgba` is base64-encoded raw RGBA bytes (length = width × height × 4).
   */
  content: {
    rgba: string;
    width: number;
    height: number;
  } | null;
  /** How content is fitted into the frame bounds. */
  fit: FrameContentFit;
  /** Manual horizontal offset of content relative to the fitted position, in canvas pixels. */
  contentOffsetX: number;
  /** Manual vertical offset of content relative to the fitted position, in canvas pixels. */
  contentOffsetY: number;
  /** Manual scale multiplier on top of the fitted size. 1.0 = use fit-mode default. */
  contentScale: number;
  /** Frame stroke colour, or null for no stroke. */
  strokeColor: RGBAColor | null;
  /** Stroke width in canvas pixels. */
  strokeWidth: number;
}

/**
 * Layer mask child — stores a single-channel grayscale mask (0=hide, 255=show)
 * painted directly on by the user. Stored as a full-canvas RGBA WebGLLayer
 * where the R channel is the mask alpha value.  Immediately follows its parent
 * in the layers array and is excluded from independent compositing.
 */
export interface MaskLayerState {
  id: string;
  name: string;
  visible: boolean;
  type: "mask";
  /** ID of the parent layer this mask belongs to. */
  parentId: string;
}

// ─── Adjustment layers ────────────────────────────────────────────────────────

import type { EffectLayerState } from "@/core/effects/effectTypes";

export type FilterKey =
  | "gaussian-blur"
  | "box-blur"
  | "radial-blur"
  | "motion-blur"
  | "remove-motion-blur"
  | "sharpen"
  | "sharpen-more"
  | "unsharp-mask"
  | "smart-sharpen"
  | "add-noise"
  | "film-grain"
  | "lens-blur"
  | "clouds"
  | "median-filter"
  | "bilateral-filter"
  | "reduce-noise"
  | "pixelate"
  | "seamless-texture"
  | "offset"
  | "repeat";

export type CurvesChannel = "rgb" | "red" | "green" | "blue";

export interface CurvesControlPoint {
  id: string;
  x: number;
  y: number;
}

export interface CurvesChannelCurve {
  points: CurvesControlPoint[];
}

export interface CurvesVisualAids {
  gridDensity: "4x4" | "8x8";
  showClippingIndicators: boolean;
  showReadout: boolean;
}

export interface CurvesPresetRef {
  source: "builtin" | "custom";
  id: string;
  name: string;
  dirty: boolean;
}

export interface CurvesPreset {
  id: string;
  name: string;
  channels: Record<CurvesChannel, CurvesChannelCurve>;
}

export interface AutoMatchSourceStats {
  /** Number of opaque pixels that contributed to this stats bucket. */
  count: number;
  /** Mean Rec.709 luma (0..1). */
  meanL: number;
  /** Standard deviation of luma (0..1). */
  stdL: number;
  /** Min/max luma observed (0..1). */
  minL: number;
  maxL: number;
  /** Per-channel mean (0..1). */
  meanR: number;
  meanG: number;
  meanB: number;
  /** Mean chroma magnitude — average length of (rgb − vec3(luma)) over the
   *  opaque pixel set. A measure of "how saturated" the source is overall. */
  chromaMag: number;
}

export interface AutoMatchStats {
  /** Stats of the parent layer's opaque pixels. */
  layer: AutoMatchSourceStats;
  /** Stats of the rest-of-image opaque pixels within `samplingDistance` of
   *  the parent layer's bounding box. */
  context: AutoMatchSourceStats;
}

export interface ColorGradingWheelParams {
  r: number;
  g: number;
  b: number;
  master: number;
}

export interface EffectLayerBase {
  id: string;
  name: string;
  visible: boolean;
  type: "adjustment";
  parentId: string;
}

/** Layer-state shape for a registered effect. Each effect declares its own
 *  params type next to its Effect class and constructs its layer alias as
 *  `EffectLayerOf<"<kind>", FooParams>`. */
export type EffectLayerOf<K extends string, P> = EffectLayerBase & {
  effectType: K;
  params: P;
  hasMask: boolean;
};

export interface GroupLayerState {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  locked: boolean;
  blendMode: BlendMode;
  type: "group";
  collapsed: boolean;
  childIds: string[];
}

/**
 * Composite Layer — non-destructively merges all child layers into a single
 * flattened result at render time. Adjustments / effects / filters can be
 * attached to the composite layer and are applied to the merged output before
 * it is composited into the rest of the document.
 */
export interface CompositeLayerState {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  locked: boolean;
  blendMode: BlendMode;
  type: "composite";
  collapsed: boolean;
  childIds: string[];
}

export type LayerState =
  | PixelLayerState
  | TextLayerState
  | ShapeLayerState
  | FrameLayerState
  | MaskLayerState
  | EffectLayerState
  | GroupLayerState
  | CompositeLayerState;

export function isFrameLayer(l: LayerState): l is FrameLayerState {
  return "type" in l && l.type === "frame";
}

export function isGroupLayer(l: LayerState): l is GroupLayerState {
  return "type" in l && l.type === "group";
}

export function isCompositeLayer(l: LayerState): l is CompositeLayerState {
  return "type" in l && l.type === "composite";
}

/** True for any layer type that owns child layers (group or composite). */
export function isContainerLayer(
  l: LayerState,
): l is GroupLayerState | CompositeLayerState {
  return "type" in l && (l.type === "group" || l.type === "composite");
}

export function isPixelLayer(l: LayerState): l is PixelLayerState {
  return !("type" in l);
}

export type BackgroundFill = "white" | "black" | "transparent";

export type GridType = "normal" | "thirds" | "safe-zone";

export interface Guide {
  id: string;
  axis: "h" | "v";
  /** Document-pixel coordinate (Y for 'h', X for 'v') */
  position: number;
}

export interface CanvasState {
  width: number;
  height: number;
  zoom: number;
  panX: number;
  panY: number;
  showGrid: boolean;
  gridSize: number;
  gridColor: string;
  gridType: GridType;
  backgroundFill: BackgroundFill;
  key: number;
  tiledMode: boolean;
  showTileGrid: boolean;
  showRulers: boolean;
  showGuides: boolean;
  guides: Guide[];
}

// ─── Pixel Brushes ─────────────────────────────────────────────────────────────

/**
 * A custom pixel-art brush captured from a canvas selection.
 * `rgba` holds the raw RGBA bytes (width × height × 4) encoded as a base64 string.
 * Transparent pixels in the brush mask (a === 0) are skipped when stamping.
 */
export interface PixelBrush {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Raw RGBA bytes, width × height × 4, base64-encoded. */
  rgba: string;
  createdAt: number;
}

export type PixelFormat = "rgba8" | "rgba32f" | "indexed8";

// Re-export brush types
export type {
  Brush,
  BrushScope,
  BrushTipKind,
  BrushTipShape,
  TipSettings,
  ScatterDynamics,
  ShapeDynamics,
  ColorDynamics,
  PoseDynamics,
  NoiseSettings,
  WetEdgeSettings,
  BuildUpSettings,
  SmudgeSettings,
  SmoothingSettings,
  PaperTexture,
  DynamicCurve,
  DynamicSource,
} from "@/core/tools/Brush/brushPreset";
export {
  makeDefaultBrush,
  identityCurve,
} from "@/core/tools/Brush/brushPreset";

export type ToneMappingOperator = "reinhard" | "clamp";

// ─── Spritesheet / Animation ──────────────────────────────────────────────────

export interface AnimationFrame {
  id: string;
  /** How many playback ticks this frame persists (1 = single tick at the animation fps). */
  duration: number;
}

export type AnimationPlaybackMode = "one-shot" | "loop" | "ping-pong";

export interface AnimationDef {
  id: string;
  name: string;
  fps: number;
  playbackMode: AnimationPlaybackMode;
  frames: AnimationFrame[];
}

export interface SpritesheetState {
  /** Whether spritesheet mode is active (cells are enabled). */
  enabled: boolean;
  /** Width of each sprite cell in pixels. */
  cellWidth: number;
  /** Height of each sprite cell in pixels. */
  cellHeight: number;
  /** Whether onion-skin overlay is active. */
  onionSkin: boolean;
  /** Number of frames to preview forward and backward in onion skin (1–3). */
  onionFrames: number;
  animations: AnimationDef[];
  selectedAnimationId: string | null;
  selectedFrameId: string | null;
}

export interface AppState {
  activeTool: Tool;
  activeShape: ShapeType;
  primaryColor: RGBAColor;
  secondaryColor: RGBAColor;
  swatches: RGBAColor[];
  swatchGroups: SwatchGroup[];
  /** Pixel brushes stored with this document (travel with the .verve file). */
  pixelBrushes: PixelBrush[];
  /** Paint brushes stored with this document (travel with the .verve file). */
  brushes: import("@/core/tools/Brush/brushPreset").Brush[];
  /** Currently selected paint brush id (looked up first in document, then user store). */
  activeBrushId: string | null;
  layers: LayerState[];
  activeLayerId: string | null;
  /** Layer IDs ctrl/cmd-clicked in the Layers panel for multi-selection operations. */
  selectedLayerIds: string[];
  canvas: CanvasState;
  history: {
    canUndo: boolean;
    canRedo: boolean;
  };
  openAdjustmentLayerId: string | null;
  pixelFormat: PixelFormat;
  /** Index of the currently selected palette entry in indexed8 mode; -1 when none. */
  activePaletteIndex: number;
  /** The index of the most recently removed swatch (for layer pixel remap); null otherwise. */
  lastRemovedSwatchIndex: number | null;
  /** When true, the playback bar is visible and the app is in spritesheet animation mode. */
  animationMode: boolean;
  spritesheet: SpritesheetState;
  paletteAnimation: PaletteAnimationState;
}
