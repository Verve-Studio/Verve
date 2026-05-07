import type { UnsharpMaskAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeUnsharpMask } from "@/graphicspipeline/webgpu/compute/filterCompute";
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
    encodeUnsharpMask(
      encoder,
      srcTex,
      dstTex,
      dstTex.width,
      dstTex.height,
      entry.amount,
      entry.radius,
      entry.threshold,
    );
  },

  Panel: UnsharpMaskPanel,
};
