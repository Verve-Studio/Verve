import type { HueSaturationAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { HueSaturationPanel } from "@/ux/windows/adjustments/HueSaturationPanel/HueSaturationPanel";
import type { IPipelineEffect } from "./IPipelineEffect";

type HueSaturationOp = Extract<AdjustmentRenderOp, { kind: "hue-saturation" }>;

export const HueSaturationEffect: IPipelineEffect<
  HueSaturationAdjustmentLayer,
  HueSaturationOp
> = {
  id: "hue-saturation",
  label: "Hue/Saturation…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: { hue: 0, saturation: 0, lightness: 0 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "hue-saturation",
      layerId: layer.id,
      hue: layer.params.hue,
      saturation: layer.params.saturation,
      lightness: layer.params.lightness,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const params = new Float32Array([
      entry.hue,
      entry.saturation,
      entry.lightness,
      0,
    ]);
    engine.encodeStdAdjRenderPass(
      encoder,
      engine.hsPipeline,
      srcTex,
      dstTex,
      format,
      params.buffer as ArrayBuffer,
      entry.selMaskLayer,
    );
  },

  Panel: HueSaturationPanel,
};
