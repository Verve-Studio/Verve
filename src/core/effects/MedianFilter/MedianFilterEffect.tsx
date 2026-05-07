import type { MedianFilterAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { getFilterRuntime } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { MedianFilterPanel } from "./MedianFilterPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type MedianFilterOp = Extract<AdjustmentRenderOp, { kind: "median-filter" }>;

export const MedianFilterEffect: IPipelineEffect<
  MedianFilterAdjustmentLayer,
  MedianFilterOp
> = {
  id: "median-filter",
  label: "Median Filter…",
  menu: { root: "filters", submenu: "noise" },
  defaultParams: { radius: 1 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "median-filter",
      layerId: layer.id,
      radius: layer.params.radius,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex }, entry) {
    const rt = getFilterRuntime();
    const pair = rt.getPipelinePair("filter-median", "fs_median");
    const paramsBuf = rt.makeParamsBuf(
      new Uint32Array([entry.radius, 0, 0, 0]),
    );
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(pair, dstTex),
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
      ],
      dstTex,
    );
  },

  Panel: MedianFilterPanel,
};
