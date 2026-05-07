import type { SharpenAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { getFilterRuntime } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { SharpenPanel } from "./SharpenPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type SharpenOp = Extract<AdjustmentRenderOp, { kind: "sharpen" }>;

export const SharpenEffect: IPipelineEffect<SharpenAdjustmentLayer, SharpenOp> =
  {
    id: "sharpen",
    label: "Sharpen",
    menu: { root: "filters", submenu: "sharpen", instant: true },
    defaultParams: {},

    buildPlanEntry(layer, { mask }) {
      return {
        kind: "sharpen",
        layerId: layer.id,
        visible: layer.visible,
        selMaskLayer: mask,
      };
    },

    encode({ encoder, srcTex, dstTex }) {
      const rt = getFilterRuntime();
      const pair = rt.getPipelinePair("filter-sharpen", "fs_sharpen");
      rt.encodeRenderPass(
        encoder,
        rt.selectPipeline(pair, dstTex),
        [{ binding: 0, resource: srcTex.createView() }],
        dstTex,
      );
    },

    Panel: SharpenPanel,
  };
