import type { RadialBlurAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeRadialBlur } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { RadialBlurPanel } from "@/ux/windows/filters/RadialBlurPanel/RadialBlurPanel";
import type { IPipelineEffect } from "./IPipelineEffect";

type RadialBlurOp = Extract<AdjustmentRenderOp, { kind: "radial-blur" }>;

export const RadialBlurEffect: IPipelineEffect<
  RadialBlurAdjustmentLayer,
  RadialBlurOp
> = {
  id: "radial-blur",
  label: "Radial Blur…",
  menu: { root: "filters", submenu: "blur" },
  defaultParams: {
    mode: 0,
    amount: 10,
    centerX: 0.5,
    centerY: 0.5,
    quality: 1,
  },

  buildPlanEntry(layer, { mask }) {
    const { mode, amount, centerX, centerY, quality } = layer.params;
    return {
      kind: "radial-blur",
      layerId: layer.id,
      mode,
      amount,
      centerX,
      centerY,
      quality,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex }, entry) {
    encodeRadialBlur(
      encoder,
      srcTex,
      dstTex,
      dstTex.width,
      dstTex.height,
      entry.mode,
      entry.amount,
      entry.centerX,
      entry.centerY,
      entry.quality,
    );
  },

  Panel: RadialBlurPanel,
};
