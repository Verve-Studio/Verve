import type { LensBlurAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeLensBlur } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { LensBlurPanel } from "./LensBlurPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type LensBlurOp = Extract<AdjustmentRenderOp, { kind: "lens-blur" }>;

export const LensBlurEffect: IPipelineEffect<
  LensBlurAdjustmentLayer,
  LensBlurOp
> = {
  id: "lens-blur",
  label: "Lens Blur…",
  menu: { root: "filters", submenu: "blur" },
  defaultParams: {
    radius: 10,
    bladeCount: 6,
    bladeCurvature: 0,
    rotation: 0,
  },

  buildPlanEntry(layer, { mask }) {
    const { radius, bladeCount, bladeCurvature, rotation } = layer.params;
    return {
      kind: "lens-blur",
      layerId: layer.id,
      radius,
      bladeCount,
      bladeCurvature,
      rotation,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex }, entry) {
    encodeLensBlur(
      encoder,
      srcTex,
      dstTex,
      dstTex.width,
      dstTex.height,
      entry.radius,
      entry.bladeCount,
      entry.bladeCurvature,
      entry.rotation,
    );
  },

  Panel: LensBlurPanel,
};
