import type { RemoveMotionBlurAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeRemoveMotionBlur } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { RemoveMotionBlurPanel } from "./RemoveMotionBlurPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type RemoveMotionBlurOp = Extract<
  AdjustmentRenderOp,
  { kind: "remove-motion-blur" }
>;

export const RemoveMotionBlurEffect: IPipelineEffect<
  RemoveMotionBlurAdjustmentLayer,
  RemoveMotionBlurOp
> = {
  id: "remove-motion-blur",
  label: "Remove Motion Blur…",
  menu: { root: "filters", submenu: "blur" },
  defaultParams: { angle: 0, distance: 10, noiseReduction: 10 },

  buildPlanEntry(layer, { mask }) {
    const { angle, distance, noiseReduction } = layer.params;
    return {
      kind: "remove-motion-blur",
      layerId: layer.id,
      angle,
      distance,
      noiseReduction,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex }, entry) {
    encodeRemoveMotionBlur(
      encoder,
      srcTex,
      dstTex,
      dstTex.width,
      dstTex.height,
      entry.angle,
      entry.distance,
      entry.noiseReduction,
    );
  },

  Panel: RemoveMotionBlurPanel,
};
