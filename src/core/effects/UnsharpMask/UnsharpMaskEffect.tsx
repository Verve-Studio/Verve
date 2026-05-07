import type { UnsharpMaskAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { getFilterRuntime } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { UnsharpMaskPanel } from "./UnsharpMaskPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type UnsharpMaskOp = Extract<AdjustmentRenderOp, { kind: "unsharp-mask" }>;

export const UnsharpMaskEffect: IPipelineEffect<
  UnsharpMaskAdjustmentLayer,
  UnsharpMaskOp
> = {
  id: "unsharp-mask",
  label: "Unsharp Mask…",
  menu: { root: "filters", submenu: "sharpen" },
  defaultParams: { amount: 50, radius: 2, threshold: 0 },

  buildPlanEntry(layer, { mask }) {
    const { amount, radius, threshold } = layer.params;
    return {
      kind: "unsharp-mask",
      layerId: layer.id,
      amount,
      radius,
      threshold,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex }, entry) {
    const rt = getFilterRuntime();
    const w = dstTex.width;
    const h = dstTex.height;
    const gaussH = rt.getPipelinePair("filter-gaussian-h", "fs_gaussian_h");
    const gaussV = rt.getPipelinePair("filter-gaussian-v", "fs_gaussian_v");
    const combine = rt.getPipelinePair(
      "filter-unsharp-combine",
      "fs_unsharp_combine",
    );

    const gaussParamsBuf = rt.makeParamsBuf(
      new Uint32Array([entry.radius, 0, 0, 0]),
    );
    const blurredTex = rt.makeRgba8Tex(w, h);
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(gaussH, rt.intermediate),
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: gaussParamsBuf } },
      ],
      rt.intermediate,
    );
    rt.encodeRenderPass(
      encoder,
      gaussV.s8,
      [
        { binding: 0, resource: rt.intermediate.createView() },
        { binding: 2, resource: { buffer: gaussParamsBuf } },
      ],
      blurredTex,
    );
    const combineParamsBuf = rt.makeParamsBuf(
      new Uint32Array([entry.amount, entry.threshold, 0, 0]),
    );
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(combine, dstTex),
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 2, resource: blurredTex.createView() },
        { binding: 3, resource: { buffer: combineParamsBuf } },
      ],
      dstTex,
    );
  },

  Panel: UnsharpMaskPanel,
};
