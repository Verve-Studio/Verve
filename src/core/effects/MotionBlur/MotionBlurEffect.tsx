import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { MotionBlurPanel } from "./MotionBlurPanel";
import type { IPipelineEffect } from "../IPipelineEffect";


export interface MotionBlurParams {
 angle: number; distance: number
}

export type MotionBlurEffectLayer = EffectLayerOf<"motion-blur", MotionBlurParams>;

/** Distances up to this many px run as one exact single pass. */
const SINGLE_PASS_MAX = 64;

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
    const { angle } = entry.params;
    const distance = Math.max(1, Math.round(entry.params.distance));
    const pass = (
      src: GPUTexture,
      dst: GPUTexture,
      taps: number,
      spacing: number,
    ): void => {
      const buf = new ArrayBuffer(16);
      const dv = new DataView(buf);
      dv.setFloat32(0, angle, true);
      dv.setUint32(4, taps, true);
      dv.setFloat32(8, spacing, true);
      dv.setUint32(12, 0, true);
      rt.encodeRenderPass(encoder, rt.selectPipeline(pair, dst), dst, [
        { binding: 0, resource: src.createView() },
        { binding: 2, resource: { buffer: rt.makeParamsBuf(buf) } },
      ]);
    };

    if (distance <= SINGLE_PASS_MAX) {
      pass(srcTex, dstTex, distance, 1);
      return;
    }
    // box(L1, step 1) ∗ comb(n2, step L1) = box of length L1·n2 ≈ distance,
    // at ~2·√distance taps per pixel instead of `distance`.
    const boxLen = Math.ceil(Math.sqrt(distance));
    const combTaps = Math.max(1, Math.round(distance / boxLen));
    const mid = rt.makeScratchTex(dstTex.width, dstTex.height, dstTex);
    pass(srcTex, mid, boxLen, 1);
    pass(mid, dstTex, combTaps, boxLen);
  },

  Panel: MotionBlurPanel,
};
