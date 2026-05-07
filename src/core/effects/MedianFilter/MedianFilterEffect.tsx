import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { MedianFilterPanel } from "./MedianFilterPanel";
import type { IPipelineEffect } from "../IPipelineEffect";


export interface MedianFilterParams {
 radius: number
}

export type MedianFilterEffectLayer = EffectLayerOf<"median-filter", MedianFilterParams>;

type MedianFilterOp = Extract<EffectRenderOp, { kind: "median-filter" }>;

export const MedianFilterEffect: IPipelineEffect<
  MedianFilterEffectLayer,
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
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const pair = rt.getRenderPipelinePair("filter-median", "fs_median");
    const paramsBuf = rt.makeParamsBuf(
      new Uint32Array([entry.params.radius, 0, 0, 0]),
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
