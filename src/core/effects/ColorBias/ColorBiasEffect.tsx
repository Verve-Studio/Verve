import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { ColorBiasPanel } from "./ColorBiasPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

const ColorBiasIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    <circle cx="6" cy="6" r="4.5" />
    <path d="M6 1.5 V10.5" strokeOpacity="0.5" />
    <circle cx="6" cy="6" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

/**
 * Distance metric used to decide which pixels fall within `range` of the
 * target colour:
 * - `rgb` — Euclidean in sRGB space. Fast, but channels aren't perceptually
 *   weighted (greens dominate). Default.
 * - `hsv` — Hue (wrapping) + saturation + value, with hue de-weighted by
 *   saturation. Best when the bias is fundamentally about hue.
 * - `lab` — CIE76 ΔE in CIE L*a*b*. Perceptually uniform — what the eye
 *   sees as "same colour" matches what the metric calls "small distance".
 *   Best for finicky scans / colour normalisation.
 */
export type ColorBiasMetric = "rgb" | "hsv" | "lab";

export interface ColorBiasParams {
  /** Sample colour as sRGB bytes (0–255). Distance is measured against this
   *  colour to decide which pixels fall inside `range`. When
   *  `useSeparateOutput` is false this is also the snap destination. Pick
   *  from canvas via the eyedropper. */
  targetColor: { r: number; g: number; b: number };
  /** When true, affected pixels snap to `outputColor` instead of
   *  `targetColor`. Lets you sample (e.g.) a muddy off-white area and snap
   *  it to pure white in a single pass. */
  useSeparateOutput: boolean;
  /** Snap destination when `useSeparateOutput` is true. Ignored otherwise. */
  outputColor: { r: number; g: number; b: number };
  /** Maximum colour distance (0–100) for a pixel to be affected. The
   *  numeric meaning of "distance" depends on `metric`. */
  range: number;
  /** Smooth-transition zone as a percentage of the range (0–100). The
   *  outermost `falloff%` of the range fades from full snap back to the
   *  original pixel, producing a soft edge instead of a hard threshold. */
  falloff: number;
  /** Colour-space the distance is computed in. */
  metric: ColorBiasMetric;
}

const METRIC_INDEX: Record<ColorBiasMetric, number> = {
  rgb: 0,
  hsv: 1,
  lab: 2,
};

export type ColorBiasEffectLayer = EffectLayerOf<"color-bias", ColorBiasParams>;

type ColorBiasOp = Extract<EffectRenderOp, { kind: "color-bias" }>;

export const ColorBiasEffect: IPipelineEffect<
  ColorBiasEffectLayer,
  ColorBiasOp
> = {
  id: "color-bias",
  label: "Color Bias…",
  menu: { root: "adjustments", submenu: "adj-style" },
  defaultParams: {
    targetColor: { r: 255, g: 255, b: 255 },
    useSeparateOutput: false,
    outputColor: { r: 255, g: 255, b: 255 },
    range: 10,
    falloff: 50,
    metric: "rgb",
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "color-bias",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const { r: sr, g: sg, b: sb } = entry.params.targetColor;
    // When the user hasn't enabled the separate output path, snap to the
    // sample colour (current behaviour). When they have, snap to outputColor.
    const outDst = entry.params.useSeparateOutput
      ? entry.params.outputColor
      : entry.params.targetColor;
    // Uniform layout (48 bytes):
    //   offset  0: targetCol   : vec3f  (sample colour, r/g/b in 0..1 sRGB)
    //   offset 12: range       : f32    (0..100)
    //   offset 16: falloff     : f32    (0..100)
    //   offset 20: metric      : u32    (0=RGB, 1=HSV, 2=LAB)
    //   offset 24: pad (8 bytes — outputCol must be 16-aligned)
    //   offset 32: outputCol   : vec3f  (snap destination, r/g/b in 0..1 sRGB)
    //   offset 44: inputLinear : u32    (1 for rgba32float source, 0 for sRGB)
    const buf = new ArrayBuffer(48);
    const f32 = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    f32[0] = sr / 255;
    f32[1] = sg / 255;
    f32[2] = sb / 255;
    f32[3] = entry.params.range;
    f32[4] = entry.params.falloff;
    u32[5] = METRIC_INDEX[entry.params.metric] ?? 0;
    f32[8] = outDst.r / 255;
    f32[9] = outDst.g / 255;
    f32[10] = outDst.b / 255;
    u32[11] = format === "rgba32float" ? 1 : 0;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair(
        "color-bias",
        "fs_color_bias",
        STD_BINDINGS,
      ),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: ColorBiasPanel,
  icon: ColorBiasIcon,
};
