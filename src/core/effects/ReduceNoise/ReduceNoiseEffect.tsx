import type { ReduceNoiseAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { ReduceNoisePanel } from "./ReduceNoisePanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type ReduceNoiseOp = Extract<AdjustmentRenderOp, { kind: "reduce-noise" }>;

export const ReduceNoiseEffect: IPipelineEffect<
  ReduceNoiseAdjustmentLayer,
  ReduceNoiseOp
> = {
  id: "reduce-noise",
  label: "Reduce Noise…",
  menu: { root: "filters", submenu: "noise" },
  defaultParams: {
    strength: 6,
    preserveDetails: 25,
    reduceColorNoise: 50,
    sharpenDetails: 0,
  },

  buildPlanEntry(layer, { mask }) {
    const { strength, preserveDetails, reduceColorNoise, sharpenDetails } =
      layer.params;
    return {
      kind: "reduce-noise",
      layerId: layer.id,
      strength,
      preserveDetails,
      reduceColorNoise,
      sharpenDetails,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const w = dstTex.width;
    const h = dstTex.height;
    const { strength, preserveDetails, reduceColorNoise, sharpenDetails } =
      entry;

    const reducePair = rt.getRenderPipelinePair(
      "filter-reduce-noise",
      "fs_reduce_noise",
    );
    const gaussH = rt.getRenderPipelinePair("filter-gaussian-h", "fs_gaussian_h");
    const gaussV = rt.getRenderPipelinePair("filter-gaussian-v", "fs_gaussian_v");
    const unsharpCombine = rt.getRenderPipelinePair(
      "filter-unsharp-combine",
      "fs_unsharp_combine",
    );

    if (sharpenDetails > 0) {
      const tempTex = rt.makeRgba8Tex(w, h);
      const rndParamsBuf = rt.makeParamsBuf(
        new Uint32Array([strength, preserveDetails, reduceColorNoise, 0]),
      );
      rt.encodeRenderPass(
        encoder,
        reducePair.s8,
        tempTex,
        [
          { binding: 0, resource: srcTex.createView() },
          { binding: 2, resource: { buffer: rndParamsBuf } },
        ],
      );
      const gaussParamsBuf = rt.makeParamsBuf(new Uint32Array([1, 0, 0, 0]));
      const blurredTex = rt.makeRgba8Tex(w, h);
      rt.encodeRenderPass(
        encoder,
        rt.selectPipeline(gaussH, rt.intermediate),
        rt.intermediate,
        [
          { binding: 0, resource: tempTex.createView() },
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
      const unsharpParamsBuf = rt.makeParamsBuf(
        new Uint32Array([Math.round(sharpenDetails * 1.5), 0, 0, 0]),
      );
      rt.encodeRenderPass(
        encoder,
        rt.selectPipeline(unsharpCombine, dstTex),
        dstTex,
        [
          { binding: 0, resource: tempTex.createView() },
          { binding: 2, resource: blurredTex.createView() },
          { binding: 3, resource: { buffer: unsharpParamsBuf } },
        ],
      );
    } else {
      const rndParamsBuf = rt.makeParamsBuf(
        new Uint32Array([strength, preserveDetails, reduceColorNoise, 0]),
      );
      rt.encodeRenderPass(
        encoder,
        rt.selectPipeline(reducePair, dstTex),
        dstTex,
        [
          { binding: 0, resource: srcTex.createView() },
          { binding: 2, resource: { buffer: rndParamsBuf } },
        ],
      );
    }
  },

  Panel: ReduceNoisePanel,
};
