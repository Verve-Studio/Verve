import type { MedianFilterAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
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

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const pair = rt.getRenderPipelinePair("filter-median", "fs_median");
    const paramsBuf = rt.makeParamsBuf(
      new Uint32Array([entry.radius, 0, 0, 0]),
    );
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(pair, dstTex),
      dstTex,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
      ],
    );
  },

  Panel: MedianFilterPanel,
};
