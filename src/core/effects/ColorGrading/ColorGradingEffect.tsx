import type { ColorGradingAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { ColorGradingPanel } from "@/ux/windows/adjustments/ColorGradingPanel/ColorGradingPanel";
import type { IPipelineEffect } from "./IPipelineEffect";

type ColorGradingOp = Extract<AdjustmentRenderOp, { kind: "color-grading" }>;

export const ColorGradingEffect: IPipelineEffect<
  ColorGradingAdjustmentLayer,
  ColorGradingOp
> = {
  id: "color-grading",
  label: "Color Grading…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: {
    lift: { r: 0, g: 0, b: 0, master: 0 },
    gamma: { r: 0, g: 0, b: 0, master: 0 },
    gain: { r: 0, g: 0, b: 0, master: 0 },
    offset: { r: 0, g: 0, b: 0, master: 0 },
    temp: 6500,
    tint: 0,
    contrast: 1.0,
    pivot: 0.435,
    midDetail: 0,
    colorBoost: 0,
    shadows: 0,
    highlights: 0,
    saturation: 50,
    hue: 50,
    lumMix: 0,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "color-grading",
      layerId: layer.id,
      params: layer.params,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    engine.encodeColorGradingRenderPass(
      encoder,
      srcTex,
      dstTex,
      format,
      entry.params,
      entry.selMaskLayer,
    );
  },

  Panel: ColorGradingPanel,
};
