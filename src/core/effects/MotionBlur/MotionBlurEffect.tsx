import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { MotionBlurPanel } from "./MotionBlurPanel";
import type { IPipelineEffect } from "../IPipelineEffect";


export interface MotionBlurParams {
 angle: number; distance: number
}

export type MotionBlurEffectLayer = EffectLayerOf<"motion-blur", MotionBlurParams>;

type MotionBlurOp = Extract<EffectRenderOp, { kind: "motion-blur" }>;

export const MotionBlurEffect: IPipelineEffect<
  MotionBlurEffectLayer,
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
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const pair = rt.getRenderPipelinePair("filter-motion-blur", "fs_motion_blur");
    const buf = new ArrayBuffer(16);
    const dv = new DataView(buf);
    dv.setFloat32(0, entry.params.angle, true);
    dv.setUint32(4, entry.params.distance, true);
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
