import type { MotionBlurAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
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

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const pair = rt.getRenderPipelinePair("filter-motion-blur", "fs_motion_blur");
    const buf = new ArrayBuffer(16);
    const dv = new DataView(buf);
    dv.setFloat32(0, entry.angle, true);
    dv.setUint32(4, entry.distance, true);
    dv.setUint32(8, 0, true);
    dv.setUint32(12, 0, true);
    const paramsBuf = rt.makeParamsBuf(buf);
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

  Panel: MotionBlurPanel,
};
