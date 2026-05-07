import type { HueSaturationAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { HueSaturationPanel } from "./HueSaturationPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphicspipeline/webgpu/AdjustmentRuntime";

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
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("hs", "fs_hue_saturation", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      params.buffer as ArrayBuffer,
      entry.selMaskLayer,
    );
  },

  Panel: HueSaturationPanel,
};
