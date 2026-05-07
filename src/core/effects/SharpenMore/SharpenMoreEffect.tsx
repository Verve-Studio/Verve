import type React from "react";
import type { SharpenMoreAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { getFilterRuntime } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { SharpenPanel } from "../Sharpen/SharpenPanel";
import type { IPipelineEffect, PanelProps } from "../IPipelineEffect";

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
    const rt = getFilterRuntime();
    const pair = rt.getPipelinePair("filter-sharpen-more", "fs_sharpen_more");
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(pair, dstTex),
      [{ binding: 0, resource: srcTex.createView() }],
      dstTex,
    );
  },

  Panel: SharpenMorePanel,
};
