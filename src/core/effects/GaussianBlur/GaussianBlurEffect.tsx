import type { GaussianBlurAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { GaussianBlurPanel } from "./GaussianBlurPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type GaussianBlurOp = Extract<AdjustmentRenderOp, { kind: "gaussian-blur" }>;

export const GaussianBlurEffect: IPipelineEffect<
  GaussianBlurAdjustmentLayer,
  GaussianBlurOp
> = {
  id: "gaussian-blur",
  label: "Gaussian Blur…",
  menu: { root: "filters", submenu: "blur" },
  defaultParams: { radius: 5 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "gaussian-blur",
      layerId: layer.id,
      radius: layer.params.radius,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const hPair = rt.getRenderPipelinePair("filter-gaussian-h", "fs_gaussian_h");
    const vPair = rt.getRenderPipelinePair("filter-gaussian-v", "fs_gaussian_v");
    const paramsBuf = rt.makeParamsBuf(
      new Uint32Array([entry.radius, 0, 0, 0]),
    );
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(hPair, rt.intermediate),
      rt.intermediate,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
      ],
    );
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(vPair, dstTex),
      dstTex,
      [
        { binding: 0, resource: rt.intermediate.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
      ],
    );
  },

  Panel: GaussianBlurPanel,
};
