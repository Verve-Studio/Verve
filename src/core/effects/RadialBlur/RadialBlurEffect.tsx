import type { RadialBlurAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { RadialBlurPanel } from "./RadialBlurPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

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

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const pair = rt.getRenderPipelinePair("filter-radial-blur", "fs_radial_blur");
    const buf = new ArrayBuffer(32);
    const dv = new DataView(buf);
    dv.setUint32(0, entry.mode, true);
    dv.setUint32(4, entry.amount, true);
    dv.setUint32(8, entry.quality, true);
    dv.setUint32(12, 0, true);
    dv.setFloat32(16, entry.centerX, true);
    dv.setFloat32(20, entry.centerY, true);
    dv.setFloat32(24, 0, true);
    dv.setFloat32(28, 0, true);
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

  Panel: RadialBlurPanel,
};
