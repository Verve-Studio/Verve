import type { GaussianBlurAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeGaussianBlur } from "@/graphicspipeline/webgpu/compute/filterCompute";
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

  encode({ encoder, srcTex, dstTex }, entry) {
    encodeGaussianBlur(
      encoder,
      srcTex,
      dstTex,
      dstTex.width,
      dstTex.height,
      entry.radius,
    );
  },

  Panel: GaussianBlurPanel,
};
