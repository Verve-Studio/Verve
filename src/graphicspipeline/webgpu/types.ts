import type { AdjustmentParamsMap, PixelFormat } from "@/types";
import type { CurvesLuts } from "@/core/operations/adjustments/curves";

// ─── Param type aliases ────────────────────────────────────────────────────────

export type ColorBalancePassParams = AdjustmentParamsMap["color-balance"];
export type BlackAndWhitePassParams = AdjustmentParamsMap["black-and-white"];
export type SelectiveColorPassParams = AdjustmentParamsMap["selective-color"];
export type ChannelMixerPassParams = AdjustmentParamsMap["channel-mixer"];
export type CurvesPassParams = AdjustmentParamsMap["curves"];
export type ColorGradingPassParams = AdjustmentParamsMap["color-grading"];

// ─── GpuLayer ─────────────────────────────────────────────────────────────────

export interface GpuLayer {
  id: string;
  name: string;
  texture: GPUTexture;
  data: Uint8Array | Float32Array;
  format: PixelFormat;
  layerWidth: number;
  layerHeight: number;
  offsetX: number;
  offsetY: number;
  opacity: number;
  visible: boolean;
  blendMode: string;
  /** Accumulated dirty region in layer-local texel coords. Expanded by tools; consumed + reset by flushLayer. */
  dirtyRect: { lx: number; ly: number; rx: number; ry: number } | null;
  /** Incremented by flushLayer() every time pixel content is uploaded to the GPU.
   *  Used by the render cache to detect content changes without full pixel comparison. */
  contentVersion: number;
}

export const BLEND_MODE_INDEX: Record<string, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  "soft-light": 4,
  "hard-light": 5,
  darken: 6,
  lighten: 7,
  difference: 8,
  exclusion: 9,
  "color-dodge": 10,
  "color-burn": 11,
};

// ─── AdjustmentRenderOp ───────────────────────────────────────────────────────

export type AdjustmentRenderOp =
  | {
      kind: "brightness-contrast";
      layerId: string;
      brightness: number;
      contrast: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "hue-saturation";
      layerId: string;
      hue: number;
      saturation: number;
      lightness: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "color-vibrance";
      layerId: string;
      vibrance: number;
      saturation: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "color-balance";
      layerId: string;
      params: ColorBalancePassParams;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "black-and-white";
      layerId: string;
      params: BlackAndWhitePassParams;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "color-temperature";
      layerId: string;
      temperature: number;
      tint: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "color-invert";
      layerId: string;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "selective-color";
      layerId: string;
      params: SelectiveColorPassParams;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "auto-match";
      layerId: string;
      /** Pre-mixed factors in 0..1 (already divided by 100). */
      strength: number;
      brightness: number;
      contrast: number;
      gamma: number;
      color: number;
      saturation: number;
      clampHighlights: boolean;
      clampShadows: boolean;
      /** Pixel statistics for the parent layer's opaque pixels (0..1). */
      layerMeanL: number;
      layerStdL: number;
      layerMinL: number;
      layerMaxL: number;
      layerMeanR: number;
      layerMeanG: number;
      layerMeanB: number;
      layerChromaMag: number;
      layerCount: number;
      /** Pixel statistics for the surroundings (rest of image, sampling-restricted). */
      contextMeanL: number;
      contextStdL: number;
      contextMinL: number;
      contextMaxL: number;
      contextMeanR: number;
      contextMeanG: number;
      contextMeanB: number;
      contextChromaMag: number;
      contextCount: number;
      /** Cache key — when this changes the renderer's content cache invalidates. */
      statsVersion: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "channel-mixer";
      layerId: string;
      params: ChannelMixerPassParams;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "curves";
      layerId: string;
      params: CurvesPassParams;
      luts: CurvesLuts;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "color-grading";
      layerId: string;
      params: ColorGradingPassParams;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "reduce-colors";
      layerId: string;
      visible: boolean;
      selMaskLayer?: GpuLayer;
      palette: Float32Array;
      paletteCount: number;
    }
  | {
      kind: "color-dithering";
      layerId: string;
      visible: boolean;
      selMaskLayer?: GpuLayer;
      palette: Float32Array;
      paletteCount: number;
      style: number; // 0=bayer4, 1=bayer8
      opacity: number;
    }
  | {
      kind: "bloom";
      layerId: string;
      threshold: number;
      strength: number;
      spread: number;
      quality: "full" | "half" | "quarter";
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "chromatic-aberration";
      layerId: string;
      caType: "radial" | "directional";
      distance: number;
      angle: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "vignette";
      layerId: string;
      shape: "ellipse" | "rectangle";
      spread: number;
      softness: number;
      opacity: number;
      /** Pre-normalised 0..1 colour components. */
      colorR: number;
      colorG: number;
      colorB: number;
      roundness: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "halation";
      layerId: string;
      threshold: number;
      spread: number;
      blur: number;
      strength: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "color-key";
      layerId: string;
      /** Key color components pre-normalised to 0..1. */
      keyR: number;
      keyG: number;
      keyB: number;
      tolerance: number; // 0..100
      softness: number; // 0..100
      dilation: number; // 0..20 px
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "drop-shadow";
      layerId: string;
      /** Shadow color components pre-normalised to 0..1. */
      colorR: number;
      colorG: number;
      colorB: number;
      colorA: number; // 0..1 (color.a / 255)
      opacity: number; // 0..1 (pre-divided by 100)
      offsetX: number; // signed pixels
      offsetY: number; // signed pixels
      spread: number; // 0..100 px
      softness: number; // 0..100 px
      blendMode: "normal" | "multiply" | "screen";
      knockout: boolean;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "glow";
      layerId: string;
      /** Glow color components pre-normalised to 0..1. */
      colorR: number;
      colorG: number;
      colorB: number;
      colorA: number; // 0..1 (color.a / 255)
      opacity: number; // 0..1 (pre-divided by 100)
      spread: number; // 0..100 px
      softness: number; // 0..100 px
      blendMode: "normal" | "multiply" | "screen";
      knockout: boolean;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "outline";
      layerId: string;
      /** Stroke color components pre-normalised to 0..1. */
      colorR: number;
      colorG: number;
      colorB: number;
      colorA: number; // 0..1 (color.a / 255)
      opacity: number; // 0..1 (pre-divided by 100)
      thickness: number; // integer 1..100 px
      position: "outside" | "inside" | "center";
      softness: number; // 0..50 px
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "halftone";
      layerId: string;
      frequency: number; // 2–50 cells per 100 px
      offsetC: number; // −50..+50 (%)
      offsetM: number;
      offsetY: number;
      offsetK: number;
      mode: "color" | "bw";
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "gaussian-blur";
      layerId: string;
      radius: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "box-blur";
      layerId: string;
      radius: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "radial-blur";
      layerId: string;
      mode: number;
      amount: number;
      centerX: number;
      centerY: number;
      quality: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "motion-blur";
      layerId: string;
      angle: number;
      distance: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "remove-motion-blur";
      layerId: string;
      angle: number;
      distance: number;
      noiseReduction: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "lens-blur";
      layerId: string;
      radius: number;
      bladeCount: number;
      bladeCurvature: number;
      rotation: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "sharpen";
      layerId: string;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "sharpen-more";
      layerId: string;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "unsharp-mask";
      layerId: string;
      amount: number;
      radius: number;
      threshold: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "smart-sharpen";
      layerId: string;
      amount: number;
      radius: number;
      reduceNoise: number;
      remove: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "add-noise";
      layerId: string;
      amount: number;
      distribution: number;
      monochromatic: number;
      seed: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "film-grain";
      layerId: string;
      grainSize: number;
      intensity: number;
      roughness: number;
      seed: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "median-filter";
      layerId: string;
      radius: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "bilateral-filter";
      layerId: string;
      radius: number;
      sigmaSpatial: number;
      sigmaColor: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "reduce-noise";
      layerId: string;
      strength: number;
      preserveDetails: number;
      reduceColorNoise: number;
      sharpenDetails: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "clouds";
      layerId: string;
      scale: number;
      opacity: number;
      colorMode: number;
      fgColor: number;
      bgColor: number;
      seed: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "pixelate";
      layerId: string;
      blockSize: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "bevel";
      layerId: string;
      width: number; // 1–50 px
      softness: number; // 0–50 px
      angle: number; // 0–360 degrees
      strength: number; // 0–1 (pre-divided by 100)
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "inner-shadow";
      layerId: string;
      colorR: number; // 0..1
      colorG: number;
      colorB: number;
      colorA: number; // 0..1
      opacity: number; // 0..1 (pre-divided by 100)
      offsetX: number; // signed pixels
      offsetY: number; // signed pixels
      spread: number; // 0–100 px
      softness: number; // 0–100 px
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "inner-glow";
      layerId: string;
      colorR: number; // 0..1
      colorG: number;
      colorB: number;
      colorA: number; // 0..1
      opacity: number; // 0..1 (pre-divided by 100)
      spread: number; // 0–100 px
      softness: number; // 0–100 px
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "lens-distortion";
      layerId: string;
      distType: number; // 0=radial, 1=fisheye, 2=mustache, 3=perspective
      edgeMode: number; // 0=transparent, 1=clamp, 2=mirror
      strength: number; // already pre-divided by 100
      secondary: number;
      centerX: number; // 0..1
      centerY: number;
      zoom: number; // already pre-divided by 100 (1.0 = no zoom)
      tiltX: number;
      tiltY: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    }
  | {
      kind: "seamless-texture";
      layerId: string;
      breakRepetition: boolean;
      cellSize: number;
      blendRadius: number;
      seamlessBorders: boolean;
      borderRadius: number;
      seed: number;
      visible: boolean;
      selMaskLayer?: GpuLayer;
    };

// ─── RenderPlanEntry ──────────────────────────────────────────────────────────

export type RenderPlanEntry =
  | { kind: "layer"; layer: GpuLayer; mask?: GpuLayer }
  | {
      kind: "adjustment-group";
      parentLayerId: string;
      baseLayer: GpuLayer;
      baseMask?: GpuLayer;
      adjustments: AdjustmentRenderOp[];
      /** When true the parent pixel layer is locked — the renderer will bake
       *  the composited output once and reuse it on every subsequent frame,
       *  and `planIsFlatLayersOnly` treats it as equivalent to a plain layer. */
      locked?: boolean;
    }
  | {
      kind: "layer-group";
      groupId: string;
      opacity: number;
      blendMode: string;
      visible: boolean;
      children: RenderPlanEntry[];
    }
  | {
      /** Non-destructive merged layer: children are flattened at render time,
       *  then `adjustments` are applied to the merged result before compositing. */
      kind: "composite-layer";
      layerId: string;
      opacity: number;
      blendMode: string;
      visible: boolean;
      children: RenderPlanEntry[];
      adjustments: AdjustmentRenderOp[];
      /** When true the composite is locked — the renderer bakes its flattened
       *  output once and reuses it on every subsequent frame, and
       *  `planIsFlatLayersOnly` treats it as equivalent to a plain layer. */
      locked?: boolean;
    }
  | AdjustmentRenderOp;

// ─── Error ────────────────────────────────────────────────────────────────────

export class WebGPUUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebGPUUnavailableError";
  }
}
