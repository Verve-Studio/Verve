import type { RadialBlurEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { RadialBlurPanel } from "./RadialBlurPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type RadialBlurOp = Extract<EffectRenderOp, { kind: "radial-blur" }>;

export const RadialBlurEffect: IPipelineEffect<
  RadialBlurEffectLayer,
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
    return {
      kind: "radial-blur",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const { mode, amount, centerX, centerY, quality } = entry.params;
    const pair = rt.getRenderPipelinePair("filter-radial-blur", "fs_radial_blur");
    const buf = new ArrayBuffer(32);
    const dv = new DataView(buf);
    dv.setUint32(0, mode, true);
    dv.setUint32(4, amount, true);
    dv.setUint32(8, quality, true);
    dv.setUint32(12, 0, true);
    dv.setFloat32(16, centerX, true);
    dv.setFloat32(20, centerY, true);
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
