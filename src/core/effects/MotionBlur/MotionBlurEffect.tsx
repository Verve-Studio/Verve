import type { MotionBlurAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeMotionBlur } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { MotionBlurPanel } from "./MotionBlurPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type MotionBlurOp = Extract<AdjustmentRenderOp, { kind: "motion-blur" }>;

export const MotionBlurEffect: IPipelineEffect<
  MotionBlurAdjustmentLayer,
  MotionBlurOp
> = {
  id: "motion-blur",
  label: "Motion Blur…",
  menu: { root: "filters", submenu: "blur" },
  defaultParams: { angle: 0, distance: 10 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "motion-blur",
      layerId: layer.id,
      angle: layer.params.angle,
      distance: layer.params.distance,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex }, entry) {
    encodeMotionBlur(
      encoder,
      srcTex,
      dstTex,
      dstTex.width,
      dstTex.height,
      entry.angle,
      entry.distance,
    );
  },

  Panel: MotionBlurPanel,
};
