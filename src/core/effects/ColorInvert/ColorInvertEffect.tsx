import type { ColorInvertAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { InvertPanel } from "./InvertPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type ColorInvertOp = Extract<AdjustmentRenderOp, { kind: "color-invert" }>;

export const ColorInvertEffect: IPipelineEffect<
  ColorInvertAdjustmentLayer,
  ColorInvertOp
> = {
  id: "color-invert",
  label: "Invert",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: {},

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "color-invert",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    engine.encodeInvertRenderPass(
      encoder,
      srcTex,
      dstTex,
      format,
      entry.selMaskLayer,
    );
  },

  Panel: InvertPanel,
};
