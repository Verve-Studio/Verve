import type React from "react";
import type { SharpenMoreAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeSharpenMore } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { SharpenPanel } from "@/ux/windows/filters/SharpenPanel/SharpenPanel";
import type { IPipelineEffect, PanelProps } from "./IPipelineEffect";

type SharpenMoreOp = Extract<AdjustmentRenderOp, { kind: "sharpen-more" }>;

// SharpenPanel is shared — it accepts both sharpen and sharpen-more layers.
const SharpenMorePanel = SharpenPanel as unknown as React.ComponentType<
  PanelProps<SharpenMoreAdjustmentLayer>
>;

export const SharpenMoreEffect: IPipelineEffect<
  SharpenMoreAdjustmentLayer,
  SharpenMoreOp
> = {
  id: "sharpen-more",
  label: "Sharpen More",
  menu: { root: "filters", submenu: "sharpen", instant: true },
  defaultParams: {},

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "sharpen-more",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex }) {
    encodeSharpenMore(encoder, srcTex, dstTex, dstTex.width, dstTex.height);
  },

  Panel: SharpenMorePanel,
};
