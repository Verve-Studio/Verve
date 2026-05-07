import type { UnsharpMaskEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { UnsharpMaskPanel } from "./UnsharpMaskPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type UnsharpMaskOp = Extract<EffectRenderOp, { kind: "unsharp-mask" }>;

export const UnsharpMaskEffect: IPipelineEffect<
  UnsharpMaskEffectLayer,
  UnsharpMaskOp
> = {
  id: "unsharp-mask",
  label: "Unsharp Mask…",
  menu: { root: "filters", submenu: "sharpen" },
  defaultParams: { amount: 50, radius: 2, threshold: 0 },

  buildPlanEntry(layer, { mask }) {
    const { amount, radius, threshold } = layer.params;
    return {
      kind: "unsharp-mask",
      layerId: layer.id,
      amount,
      radius,
      threshold,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const w = dstTex.width;
    const h = dstTex.height;
    const gaussH = rt.getRenderPipelinePair("filter-gaussian-h", "fs_gaussian_h");
    const gaussV = rt.getRenderPipelinePair("filter-gaussian-v", "fs_gaussian_v");
    const combine = rt.getRenderPipelinePair(
      "filter-unsharp-combine",
      "fs_unsharp_combine",
    );

    const gaussParamsBuf = rt.makeParamsBuf(
      new Uint32Array([entry.radius, 0, 0, 0]),
    );
    const blurredTex = rt.makeRgba8Tex(w, h);
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(gaussH, rt.intermediate),
      rt.intermediate,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: gaussParamsBuf } },
      ],
    );
    rt.encodeRenderPass(
      encoder,
      gaussV.s8,
      blurredTex,
      [
        { binding: 0, resource: rt.intermediate.createView() },
        { binding: 2, resource: { buffer: gaussParamsBuf } },
      ],
    );
    const combineParamsBuf = rt.makeParamsBuf(
      new Uint32Array([entry.amount, entry.threshold, 0, 0]),
    );
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(combine, dstTex),
      dstTex,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 2, resource: blurredTex.createView() },
        { binding: 3, resource: { buffer: combineParamsBuf } },
      ],
    );
  },

  Panel: UnsharpMaskPanel,
};
