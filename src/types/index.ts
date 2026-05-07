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
  | "select"
  | "lasso"
  | "polygonal-selection"
  | "object-selection"
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

export interface SwatchGroup {
  id: string;
  name: string;
  swatchIndices: number[];
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

export interface PixelLayerState {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  locked: boolean;
  blendMode: BlendMode;
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

export type EffectType =
  | "brightness-contrast"
  | "hue-saturation"
  | "color-vibrance"
  | "color-balance"
  | "black-and-white"
  | "color-temperature"
  | "color-invert"
  | "selective-color"
  | "channel-mixer"
  | "auto-match"
  | "curves"
  | "color-grading"
  | "reduce-colors"
  | "color-dithering"
  | "bloom"
  | "chromatic-aberration"
  | "halation"
  | "color-key"
  | "drop-shadow"
  | "glow"
  | "outline"
  | "halftone"
  | "gaussian-blur"
  | "box-blur"
  | "radial-blur"
  | "motion-blur"
  | "remove-motion-blur"
  | "lens-blur"
  | "sharpen"
  | "sharpen-more"
  | "unsharp-mask"
  | "smart-sharpen"
  | "add-noise"
  | "film-grain"
  | "median-filter"
  | "bilateral-filter"
  | "reduce-noise"
  | "clouds"
  | "pixelate"
  | "bevel"
  | "inner-shadow"
  | "inner-glow"
  | "seamless-texture"
  | "vignette"
  | "lens-distortion"
  | "pinch"
  | "polar-coordinates"
  | "ripple"
  | "shear"
  | "twirl"
  | "displace"
  | "offset"
  | "lens-flare";

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
  | "offset";

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

export interface EffectParamsMap {
  "brightness-contrast": { brightness: number; contrast: number };
  "hue-saturation": { hue: number; saturation: number; lightness: number };
  "color-vibrance": { vibrance: number; saturation: number };
  "color-balance": {
    shadows: { cr: number; mg: number; yb: number };
    midtones: { cr: number; mg: number; yb: number };
    highlights: { cr: number; mg: number; yb: number };
    preserveLuminosity: boolean;
  };
  "black-and-white": {
    reds: number;
    yellows: number;
    greens: number;
    cyans: number;
    blues: number;
    magentas: number;
  };
  "color-temperature": {
    temperature: number;
    tint: number;
  };
  "color-invert": Record<never, never>;
  "selective-color": {
    reds: { cyan: number; magenta: number; yellow: number; black: number };
    yellows: { cyan: number; magenta: number; yellow: number; black: number };
    greens: { cyan: number; magenta: number; yellow: number; black: number };
    cyans: { cyan: number; magenta: number; yellow: number; black: number };
    blues: { cyan: number; magenta: number; yellow: number; black: number };
    magentas: { cyan: number; magenta: number; yellow: number; black: number };
    whites: { cyan: number; magenta: number; yellow: number; black: number };
    neutrals: { cyan: number; magenta: number; yellow: number; black: number };
    blacks: { cyan: number; magenta: number; yellow: number; black: number };
    mode: "relative" | "absolute";
  };
  /**
   * Per-source statistics captured by the Auto Match analysis pass. Each
   * value is in linear-display units of 0..1 (luma channels) or raw 0..1
   * sRGB byte/255 (mean R/G/B). `count` is the number of opaque pixels that
   * contributed; when 0 the stats are invalid and the apply pass becomes a
   * pass-through.
   */
  "auto-match": {
    /** Pixel radius around the parent layer's bounding box used to gather
     *  context (rest-of-image) statistics. */
    samplingDistance: number;
    /** Overall match strength (0..100). 0 = pass-through, 100 = full match. */
    strength: number;
    /** Per-component micro-adjustments (0..200, default 100 = match exactly). */
    brightness: number;
    contrast: number;
    gamma: number;
    color: number;
    /** Saturation match (0..200). Scales the layer's chroma magnitude toward
     *  the surroundings'. 100 = match exactly, 0 = leave saturation alone,
     *  200 = double the match strength (clamped at the per-axis caps). */
    saturation: number;
    /** When true, clamps output luma to the surroundings' max luma. */
    clampHighlights: boolean;
    /** When true, clamps output luma below the surroundings' min luma. */
    clampShadows: boolean;
    /** Cached statistics produced by the analysis pass. Null until first analyze. */
    cachedStats: AutoMatchStats | null;
    /** Bumped every time analysis finishes; forces render-plan recomputation. */
    statsVersion: number;
  };
  "channel-mixer": {
    monochrome: boolean;
    /** Output channel currently shown in the panel UI. */
    outputChannel: "red" | "green" | "blue" | "gray";
    /** Source-channel multipliers (-200..+200, expressed as percent) and constant offset. */
    red: { red: number; green: number; blue: number; constant: number };
    green: { red: number; green: number; blue: number; constant: number };
    blue: { red: number; green: number; blue: number; constant: number };
    gray: { red: number; green: number; blue: number; constant: number };
  };
  curves: {
    version: 1;
    channels: Record<CurvesChannel, CurvesChannelCurve>;
    ui: {
      selectedChannel: CurvesChannel;
      visualAids: CurvesVisualAids;
      presetRef: CurvesPresetRef | null;
    };
  };
  "color-grading": {
    lift: ColorGradingWheelParams;
    gamma: ColorGradingWheelParams;
    gain: ColorGradingWheelParams;
    offset: ColorGradingWheelParams;
    temp: number;
    tint: number;
    contrast: number;
    pivot: number;
    midDetail: number;
    colorBoost: number;
    shadows: number;
    highlights: number;
    saturation: number;
    hue: number;
    lumMix: number;
  };
  "reduce-colors": {
    mode: "reduce" | "palette";
    colorCount: number;
    derivedPalette: RGBAColor[] | null;
  };
  "color-dithering": {
    style: "bayer4" | "bayer8";
    opacity: number;
  };
  bloom: {
    threshold: number;
    strength: number;
    spread: number;
    quality: "full" | "half" | "quarter";
  };
  "chromatic-aberration": {
    type: "radial" | "directional";
    distance: number; // 0–50 px
    angle: number; // 0–360 degrees (used only when type === 'directional')
  };
  /** Photoshop-style Pinch — pulls pixels toward (positive amount) or pushes
   *  them away from (negative) a centre point with a smooth radial falloff. */
  pinch: {
    /** −100..100. Positive pinches inward, negative spherises outward. */
    amount: number;
    /** Falloff radius as a fraction of the image's half-diagonal (0..1). */
    radius: number;
    centerX: number;
    centerY: number;
    edgeMode: "transparent" | "clamp" | "mirror";
  };
  /** Photoshop's Polar Coordinates: rect↔polar coordinate conversion. */
  "polar-coordinates": {
    mode: "rect-to-polar" | "polar-to-rect";
    centerX: number;
    centerY: number;
    edgeMode: "transparent" | "clamp" | "mirror";
  };
  /** Sinusoidal Ripple displacement (Photoshop's Distort → Ripple). */
  ripple: {
    /** Wave amplitude, −500..500 (≈px peak displacement). */
    amount: number;
    /** Wavelength control (1..100, larger = bigger waves). */
    size: number;
    /** Which axes ripple along. `both` produces a cross-pattern. */
    direction: "horizontal" | "vertical" | "both";
    edgeMode: "transparent" | "clamp" | "mirror";
  };
  /** Shear — sinusoidal or linear horizontal/vertical pixel shifting. */
  shear: {
    /** Total pixel shift across the axis (−500..500). */
    amplitude: number;
    /** Axis the shift acts on. `horizontal` shifts pixels along X by an
     *  amount that varies with Y; `vertical` is the opposite. */
    direction: "horizontal" | "vertical";
    /** 0 = pure linear shear, >0 introduces sine-wave shape (Photoshop's
     *  free-form curve approximated via a frequency control). 0..10. */
    waveFrequency: number;
    edgeMode: "transparent" | "clamp" | "mirror";
  };
  /** Twirl — angular rotation that decays from a centre point. */
  twirl: {
    /** Twirl angle in degrees (−1080..1080, multi-rev allowed). */
    angle: number;
    centerX: number;
    centerY: number;
    /** Effective twirl radius as fraction of the image half-diagonal (0..1). */
    radius: number;
    edgeMode: "transparent" | "clamp" | "mirror";
  };
  /** Displace — procedural noise-driven pixel displacement. Photoshop's
   *  Displace uses a .psd map; we use Perlin-style noise as a built-in
   *  source so the effect runs without an additional layer pick. */
  displace: {
    /** Horizontal displacement scale in pixels at noise peak (−200..200). */
    horizontalScale: number;
    /** Vertical displacement scale in pixels at noise peak. */
    verticalScale: number;
    /** Noise frequency (1..200, higher = finer-grained noise). */
    noiseFrequency: number;
    /** Random seed so users can vary the displacement pattern. */
    seed: number;
    edgeMode: "transparent" | "clamp" | "mirror";
  };
  /** Wrap-around pixel offset (Photoshop's Filter > Other > Offset). */
  offset: {
    /** Horizontal shift in pixels. Positive = image moves right; pixels
     *  pushed off the right edge reappear on the left. */
    offsetX: number;
    /** Vertical shift in pixels. Positive = image moves down; pixels pushed
     *  off the bottom reappear on the top. */
    offsetY: number;
  };
  "lens-distortion": {
    /** Distortion model. `radial` covers barrel/pincushion via signed strength;
     *  `fisheye` is an equidistant fisheye projection; `mustache` adds a
     *  fourth-order term for the classic wave/moustache lens defect;
     *  `perspective` is a keystone-style projective transform. */
    type: "radial" | "fisheye" | "mustache" | "perspective";
    /** Primary distortion strength. −100 = max pincushion, +100 = max barrel.
     *  For fisheye, magnitude controls the field-of-view; sign is ignored. */
    strength: number;
    /** Secondary (4th-order) distortion term, used only by `mustache`. */
    secondary: number;
    /** Distortion centre in normalised image coords (0..1, default 0.5). */
    centerX: number;
    centerY: number;
    /** Post-distortion zoom (50..200%, 100 = no zoom). Used to crop barrel
     *  shrinkage or compensate for the empty corners pincushion produces. */
    zoom: number;
    /** Perspective tilt around the vertical axis (−100..100). */
    tiltX: number;
    /** Perspective tilt around the horizontal axis (−100..100). */
    tiltY: number;
    /** What to sample when the distorted UV falls outside the source image:
     *  `transparent` leaves it empty, `clamp` repeats the edge, `mirror`
     *  reflects. */
    edgeMode: "transparent" | "clamp" | "mirror";
  };
  halation: {
    threshold: number; // 0–1: luminance level above which halation activates
    spread: number; // 0–100 px: blur radius
    blur: number; // 1–5: number of H+V blur iterations (more = softer)
    strength: number; // 0–1: composite intensity
  };
  "color-key": {
    /** Key color as sRGB bytes (0–255). */
    keyColor: { r: number; g: number; b: number };
    /** Pixels with HSV distance ≤ tolerance are fully transparent. Range 0–100. */
    tolerance: number;
    /** Width of the soft-edge transition zone beyond the tolerance boundary. Range 0–100. */
    softness: number;
    /** Expand the keyed-out region by this many pixels. Range 0–20. */
    dilation: number;
  };
  "drop-shadow": {
    /** Shadow color including alpha channel. r/g/b/a are 0–255. Default: { r:0, g:0, b:0, a:255 } */
    color: RGBAColor;
    /** Overall shadow opacity, 0–100 (%). Applied on top of color.a. Default: 75 */
    opacity: number;
    /** Horizontal offset in canvas pixels, −200 to +200. Default: 5 */
    offsetX: number;
    /** Vertical offset in canvas pixels, −200 to +200. Default: 5 */
    offsetY: number;
    /** Morphological dilation radius in pixels, 0–100. Default: 0 */
    spread: number;
    /** Gaussian blur radius in pixels, 0–100. Default: 10 */
    softness: number;
    /** How the shadow composites with layers beneath it. Default: 'multiply' */
    blendMode: "normal" | "multiply" | "screen";
    /** When true, the shadow is masked by the inverse of the source alpha. Default: true */
    knockout: boolean;
  };
  glow: {
    /** Glow color including alpha channel. r/g/b/a are 0–255. Default: { r:255, g:255, b:153, a:255 } */
    color: RGBAColor;
    /** Overall glow opacity, 0–100 (%). Applied on top of color.a. Default: 75 */
    opacity: number;
    /** Morphological dilation radius in pixels, 0–100. Default: 0 */
    spread: number;
    /** Gaussian blur radius in pixels, 0–100. Default: 15 */
    softness: number;
    /** How the glow composites with layers beneath it. Default: 'normal' */
    blendMode: "normal" | "multiply" | "screen";
    /** When true, the glow is masked by the inverse of the source alpha (outer glow only). Default: true */
    knockout: boolean;
  };
  outline: {
    /** Stroke color including alpha. r/g/b/a are 0–255. Default: { r:255, g:0, b:0, a:255 } */
    color: RGBAColor;
    /** Overall stroke opacity, 0–100 (%). Applied on top of color.a. Default: 100 */
    opacity: number;
    /** Stroke width in pixels, 1–100. Integer values only. Default: 3 */
    thickness: number;
    /** Controls which side of the silhouette boundary the stroke occupies. Default: 'outside' */
    position: "outside" | "inside" | "center";
    /** Gaussian-approximation blur radius for the stroke mask, 0–50 px. Default: 0 */
    softness: number;
  };
  halftone: {
    mode: "color" | "bw";
    frequency: number;
    offsetC: number;
    offsetM: number;
    offsetY: number;
    offsetK: number;
  };
  "gaussian-blur": { radius: number };
  "box-blur": { radius: number };
  "radial-blur": {
    mode: 0 | 1;
    amount: number;
    centerX: number;
    centerY: number;
    quality: 0 | 1 | 2;
  };
  "motion-blur": { angle: number; distance: number };
  "remove-motion-blur": {
    angle: number;
    distance: number;
    noiseReduction: number;
  };
  "lens-blur": {
    radius: number;
    bladeCount: number;
    bladeCurvature: number;
    rotation: number;
  };
  sharpen: Record<string, never>;
  "sharpen-more": Record<string, never>;
  "unsharp-mask": { amount: number; radius: number; threshold: number };
  "smart-sharpen": {
    amount: number;
    radius: number;
    reduceNoise: number;
    remove: "gaussian" | "lens-blur";
  };
  "add-noise": {
    amount: number;
    distribution: "uniform" | "gaussian";
    monochromatic: boolean;
    seed: number;
  };
  "film-grain": {
    grainSize: number;
    intensity: number;
    roughness: number;
    seed: number;
  };
  "median-filter": { radius: number };
  "bilateral-filter": {
    radius: number;
    sigmaSpatial: number;
    sigmaColor: number;
  };
  "reduce-noise": {
    strength: number;
    preserveDetails: number;
    reduceColorNoise: number;
    sharpenDetails: number;
  };
  clouds: {
    scale: number;
    opacity: number;
    colorMode: "grayscale" | "color";
    fgR: number;
    fgG: number;
    fgB: number;
    bgR: number;
    bgG: number;
    bgB: number;
    seed: number;
  };
  pixelate: { blockSize: number };
  /** Photographic lens flare overlay, additively composited over the layer. */
  "lens-flare": {
    /** Flare center X in canvas-pixel coordinates. */
    centerX: number;
    /** Flare center Y in canvas-pixel coordinates. */
    centerY: number;
    /** Overall brightness multiplier, 10–300%. */
    brightness: number;
    /** Lens type preset: 0 = zoom, 1 = 35mm, 2 = 105mm, 3 = movie, 4 = anamorphic. */
    lensType: number;
    /** Iris-ring opacity, 0–100%. */
    ringOpacity: number;
    /** Streak intensity, 0–100%. */
    streakStrength: number;
    /** Streak width, 1–500%. */
    streakWidth: number;
    /** Streak rotation, 0–359°. */
    streakRotation: number;
  };
  vignette: {
    /** "ellipse" — soft elliptical falloff; "rectangle" — super-ellipse with controllable corners. */
    shape: "ellipse" | "rectangle";
    /** Where the vignette begins. 0 = at the center, 1 = at the corner (no vignette). */
    spread: number;
    /** Width of the falloff band. 0 = hard edge, 1 = very soft. */
    softness: number;
    /** Overall opacity of the vignette overlay. 0–1. */
    opacity: number;
    /** Vignette colour as sRGB bytes (0–255). */
    color: { r: number; g: number; b: number };
    /** Corner roundness for `shape: "rectangle"`. 0 = sharp rectangle, 1 = ellipse. */
    roundness: number;
  };
  "seamless-texture": {
    /** Enable the Voronoi island break-repetition pass. Default: true */
    breakRepetition: boolean;
    /** Cell/island size in pixels (1–512). Default: 128 */
    cellSize: number;
    /** Blend/feather radius in pixels at island borders (0–128). Default: 16 */
    blendRadius: number;
    /** Enable the seamless border blending pass. Default: true */
    seamlessBorders: boolean;
    /** Border blend radius in pixels (1–256). Default: 32 */
    borderRadius: number;
    /** Random seed. */
    seed: number;
  };
  bevel: {
    /** Dilation radius in pixels (1–50). Controls bevel width. */
    width: number;
    /** Blur radius in pixels (0–50). Controls softness of bevel edges. */
    softness: number;
    /** Light direction in degrees (0–360). 0° = right, 90° = down. */
    angle: number;
    /** Bevel intensity, 0–100 (%). */
    strength: number;
  };
  "inner-shadow": {
    /** Shadow color including alpha. r/g/b/a are 0–255. */
    color: RGBAColor;
    /** Overall shadow opacity, 0–100 (%). */
    opacity: number;
    /** Horizontal offset in pixels, −200 to +200. */
    offsetX: number;
    /** Vertical offset in pixels, −200 to +200. */
    offsetY: number;
    /** Erosion radius in pixels, 0–100. Controls spread of shadow inside shape. */
    spread: number;
    /** Blur radius in pixels, 0–100. Controls softness of shadow edges. */
    softness: number;
  };
  "inner-glow": {
    /** Glow color including alpha. r/g/b/a are 0–255. Default: { r:255, g:255, b:153, a:255 } */
    color: RGBAColor;
    /** Overall glow opacity, 0–100 (%). Default: 75 */
    opacity: number;
    /** Erosion radius in pixels, 0–100. Controls how far the glow spreads inward. Default: 0 */
    spread: number;
    /** Blur radius in pixels, 0–100. Controls softness of glow edges. Default: 15 */
    softness: number;
  };
}

export type OutlineParams = EffectParamsMap["outline"];

export interface ColorGradingWheelParams {
  r: number;
  g: number;
  b: number;
  master: number;
}

interface EffectLayerBase {
  id: string;
  name: string;
  visible: boolean;
  type: "adjustment";
  parentId: string;
}

export interface BrightnessContrastEffectLayer extends EffectLayerBase {
  effectType: "brightness-contrast";
  params: EffectParamsMap["brightness-contrast"];
  /** True when a selection was active at creation time; baked mask pixels live in Canvas adjustmentMaskMap. */
  hasMask: boolean;
}

export interface HueSaturationEffectLayer extends EffectLayerBase {
  effectType: "hue-saturation";
  params: EffectParamsMap["hue-saturation"];
  /** True when a selection was active at creation time; baked mask pixels live in Canvas adjustmentMaskMap. */
  hasMask: boolean;
}

export interface ColorVibranceEffectLayer extends EffectLayerBase {
  effectType: "color-vibrance";
  params: EffectParamsMap["color-vibrance"];
  /** True when a selection was active at creation time; baked mask pixels live in Canvas adjustmentMaskMap. */
  hasMask: boolean;
}

export interface ColorBalanceEffectLayer extends EffectLayerBase {
  effectType: "color-balance";
  params: EffectParamsMap["color-balance"];
  /** True when a selection was active at creation time; the baked mask pixels
   *  live in useCanvas.adjustmentMaskMap (not in React state). */
  hasMask: boolean;
}

export interface BlackAndWhiteEffectLayer extends EffectLayerBase {
  effectType: "black-and-white";
  params: EffectParamsMap["black-and-white"];
  /** True when a selection was active at creation time; the baked mask pixels
   *  live in useCanvas.adjustmentMaskMap (not in React state). */
  hasMask: boolean;
}

export interface ColorTemperatureEffectLayer extends EffectLayerBase {
  effectType: "color-temperature";
  params: EffectParamsMap["color-temperature"];
  /** True when a selection was active at creation time; the baked mask pixels
   *  live in useCanvas.adjustmentMaskMap (not in React state). */
  hasMask: boolean;
}

export interface ColorInvertEffectLayer extends EffectLayerBase {
  effectType: "color-invert";
  params: EffectParamsMap["color-invert"];
  /** True when a selection was active at creation time; the baked mask pixels
   *  live in useCanvas.adjustmentMaskMap (not in React state). */
  hasMask: boolean;
}

export interface SelectiveColorEffectLayer extends EffectLayerBase {
  effectType: "selective-color";
  params: EffectParamsMap["selective-color"];
  /** True when a selection was active at creation time; the baked mask pixels
   *  live in useCanvas.adjustmentMaskMap (not in React state). */
  hasMask: boolean;
}

export interface AutoMatchEffectLayer extends EffectLayerBase {
  effectType: "auto-match";
  params: EffectParamsMap["auto-match"];
  hasMask: boolean;
}

export interface ChannelMixerEffectLayer extends EffectLayerBase {
  effectType: "channel-mixer";
  params: EffectParamsMap["channel-mixer"];
  /** True when a selection was active at creation time; the baked mask pixels
   *  live in useCanvas.adjustmentMaskMap (not in React state). */
  hasMask: boolean;
}

export interface CurvesEffectLayer extends EffectLayerBase {
  effectType: "curves";
  params: EffectParamsMap["curves"];
  /** True when a selection was active at creation time; the baked mask pixels
   *  live in useCanvas.adjustmentMaskMap (not in React state). */
  hasMask: boolean;
}

export interface ColorGradingEffectLayer extends EffectLayerBase {
  effectType: "color-grading";
  params: EffectParamsMap["color-grading"];
  /** True when a selection was active at creation time; baked mask pixels live
   *  in Canvas adjustmentMaskMap, not in React state. */
  hasMask: boolean;
}

export interface ReduceColorsEffectLayer extends EffectLayerBase {
  effectType: "reduce-colors";
  params: EffectParamsMap["reduce-colors"];
  hasMask: boolean;
}

export interface ColorDitheringEffectLayer extends EffectLayerBase {
  effectType: "color-dithering";
  params: EffectParamsMap["color-dithering"];
  hasMask: boolean;
}

export interface BloomEffectLayer extends EffectLayerBase {
  effectType: "bloom";
  params: EffectParamsMap["bloom"];
  hasMask: boolean;
}

export interface ChromaticAberrationEffectLayer extends EffectLayerBase {
  effectType: "chromatic-aberration";
  params: EffectParamsMap["chromatic-aberration"];
  hasMask: boolean;
}

export interface HalationEffectLayer extends EffectLayerBase {
  effectType: "halation";
  params: EffectParamsMap["halation"];
  hasMask: boolean;
}

export interface ColorKeyEffectLayer extends EffectLayerBase {
  effectType: "color-key";
  params: EffectParamsMap["color-key"];
  hasMask: boolean;
}

export interface DropShadowEffectLayer extends EffectLayerBase {
  effectType: "drop-shadow";
  params: EffectParamsMap["drop-shadow"];
  hasMask: boolean;
}

export interface GlowEffectLayer extends EffectLayerBase {
  effectType: "glow";
  params: EffectParamsMap["glow"];
  hasMask: boolean;
}

export interface OutlineEffectLayer extends EffectLayerBase {
  effectType: "outline";
  params: EffectParamsMap["outline"];
  hasMask: boolean;
}

export interface HalftoneEffectLayer extends EffectLayerBase {
  effectType: "halftone";
  params: EffectParamsMap["halftone"];
  hasMask: boolean;
}

export interface GaussianBlurEffectLayer extends EffectLayerBase {
  effectType: "gaussian-blur";
  params: EffectParamsMap["gaussian-blur"];
  hasMask: boolean;
}

export interface BoxBlurEffectLayer extends EffectLayerBase {
  effectType: "box-blur";
  params: EffectParamsMap["box-blur"];
  hasMask: boolean;
}

export interface RadialBlurEffectLayer extends EffectLayerBase {
  effectType: "radial-blur";
  params: EffectParamsMap["radial-blur"];
  hasMask: boolean;
}

export interface MotionBlurEffectLayer extends EffectLayerBase {
  effectType: "motion-blur";
  params: EffectParamsMap["motion-blur"];
  hasMask: boolean;
}

export interface RemoveMotionBlurEffectLayer extends EffectLayerBase {
  effectType: "remove-motion-blur";
  params: EffectParamsMap["remove-motion-blur"];
  hasMask: boolean;
}

export interface LensBlurEffectLayer extends EffectLayerBase {
  effectType: "lens-blur";
  params: EffectParamsMap["lens-blur"];
  hasMask: boolean;
}

export interface SharpenEffectLayer extends EffectLayerBase {
  effectType: "sharpen";
  params: EffectParamsMap["sharpen"];
  hasMask: boolean;
}

export interface SharpenMoreEffectLayer extends EffectLayerBase {
  effectType: "sharpen-more";
  params: EffectParamsMap["sharpen-more"];
  hasMask: boolean;
}

export interface UnsharpMaskEffectLayer extends EffectLayerBase {
  effectType: "unsharp-mask";
  params: EffectParamsMap["unsharp-mask"];
  hasMask: boolean;
}

export interface SmartSharpenEffectLayer extends EffectLayerBase {
  effectType: "smart-sharpen";
  params: EffectParamsMap["smart-sharpen"];
  hasMask: boolean;
}

export interface AddNoiseEffectLayer extends EffectLayerBase {
  effectType: "add-noise";
  params: EffectParamsMap["add-noise"];
  hasMask: boolean;
}

export interface FilmGrainEffectLayer extends EffectLayerBase {
  effectType: "film-grain";
  params: EffectParamsMap["film-grain"];
  hasMask: boolean;
}

export interface MedianFilterEffectLayer extends EffectLayerBase {
  effectType: "median-filter";
  params: EffectParamsMap["median-filter"];
  hasMask: boolean;
}

export interface BilateralFilterEffectLayer extends EffectLayerBase {
  effectType: "bilateral-filter";
  params: EffectParamsMap["bilateral-filter"];
  hasMask: boolean;
}

export interface ReduceNoiseEffectLayer extends EffectLayerBase {
  effectType: "reduce-noise";
  params: EffectParamsMap["reduce-noise"];
  hasMask: boolean;
}

export interface CloudsEffectLayer extends EffectLayerBase {
  effectType: "clouds";
  params: EffectParamsMap["clouds"];
  hasMask: boolean;
}

export interface PixelateEffectLayer extends EffectLayerBase {
  effectType: "pixelate";
  params: EffectParamsMap["pixelate"];
  hasMask: boolean;
}

export interface LensFlareEffectLayer extends EffectLayerBase {
  effectType: "lens-flare";
  params: EffectParamsMap["lens-flare"];
  hasMask: boolean;
}

export interface BevelEffectLayer extends EffectLayerBase {
  effectType: "bevel";
  params: EffectParamsMap["bevel"];
  hasMask: boolean;
}

export interface InnerShadowEffectLayer extends EffectLayerBase {
  effectType: "inner-shadow";
  params: EffectParamsMap["inner-shadow"];
  hasMask: boolean;
}

export interface InnerGlowEffectLayer extends EffectLayerBase {
  effectType: "inner-glow";
  params: EffectParamsMap["inner-glow"];
  hasMask: boolean;
}

export interface SeamlessTextureEffectLayer extends EffectLayerBase {
  effectType: "seamless-texture";
  params: EffectParamsMap["seamless-texture"];
  hasMask: boolean;
}

export interface VignetteEffectLayer extends EffectLayerBase {
  effectType: "vignette";
  params: EffectParamsMap["vignette"];
  hasMask: boolean;
}

export interface LensDistortionEffectLayer extends EffectLayerBase {
  effectType: "lens-distortion";
  params: EffectParamsMap["lens-distortion"];
  hasMask: boolean;
}

export interface OffsetEffectLayer extends EffectLayerBase {
  effectType: "offset";
  params: EffectParamsMap["offset"];
  hasMask: boolean;
}

export interface PinchEffectLayer extends EffectLayerBase {
  effectType: "pinch";
  params: EffectParamsMap["pinch"];
  hasMask: boolean;
}

export interface PolarCoordinatesEffectLayer extends EffectLayerBase {
  effectType: "polar-coordinates";
  params: EffectParamsMap["polar-coordinates"];
  hasMask: boolean;
}

export interface RippleEffectLayer extends EffectLayerBase {
  effectType: "ripple";
  params: EffectParamsMap["ripple"];
  hasMask: boolean;
}

export interface ShearEffectLayer extends EffectLayerBase {
  effectType: "shear";
  params: EffectParamsMap["shear"];
  hasMask: boolean;
}

export interface TwirlEffectLayer extends EffectLayerBase {
  effectType: "twirl";
  params: EffectParamsMap["twirl"];
  hasMask: boolean;
}

export interface DisplaceEffectLayer extends EffectLayerBase {
  effectType: "displace";
  params: EffectParamsMap["displace"];
  hasMask: boolean;
}

export type EffectLayerState =
  | BrightnessContrastEffectLayer
  | HueSaturationEffectLayer
  | ColorVibranceEffectLayer
  | ColorBalanceEffectLayer
  | BlackAndWhiteEffectLayer
  | ColorTemperatureEffectLayer
  | ColorInvertEffectLayer
  | SelectiveColorEffectLayer
  | ChannelMixerEffectLayer
  | AutoMatchEffectLayer
  | CurvesEffectLayer
  | ColorGradingEffectLayer
  | ReduceColorsEffectLayer
  | ColorDitheringEffectLayer
  | BloomEffectLayer
  | ChromaticAberrationEffectLayer
  | HalationEffectLayer
  | ColorKeyEffectLayer
  | DropShadowEffectLayer
  | GlowEffectLayer
  | OutlineEffectLayer
  | HalftoneEffectLayer
  | GaussianBlurEffectLayer
  | BoxBlurEffectLayer
  | RadialBlurEffectLayer
  | MotionBlurEffectLayer
  | RemoveMotionBlurEffectLayer
  | LensBlurEffectLayer
  | SharpenEffectLayer
  | SharpenMoreEffectLayer
  | UnsharpMaskEffectLayer
  | SmartSharpenEffectLayer
  | AddNoiseEffectLayer
  | FilmGrainEffectLayer
  | MedianFilterEffectLayer
  | BilateralFilterEffectLayer
  | ReduceNoiseEffectLayer
  | CloudsEffectLayer
  | PixelateEffectLayer
  | LensFlareEffectLayer
  | BevelEffectLayer
  | InnerShadowEffectLayer
  | InnerGlowEffectLayer
  | SeamlessTextureEffectLayer
  | VignetteEffectLayer
  | LensDistortionEffectLayer
  | PinchEffectLayer
  | PolarCoordinatesEffectLayer
  | RippleEffectLayer
  | ShearEffectLayer
  | TwirlEffectLayer
  | DisplaceEffectLayer
  | OffsetEffectLayer;

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
} from "./brush";
export { makeDefaultBrush, identityCurve } from "./brush";

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
  brushes: import("./brush").Brush[];
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
}
