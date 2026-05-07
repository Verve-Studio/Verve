import type { MedianFilterAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeMedian } from "@/graphicspipeline/webgpu/compute/filterCompute";
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
    encodeMedian(
      encoder,
      srcTex,
      dstTex,
      dstTex.width,
      dstTex.height,
      entry.radius,
    );
  },

  Panel: MedianFilterPanel,
};
