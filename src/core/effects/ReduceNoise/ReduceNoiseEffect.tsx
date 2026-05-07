import type { ReduceNoiseAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeReduceNoise } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { ReduceNoisePanel } from "@/ux/windows/filters/ReduceNoisePanel/ReduceNoisePanel";
import type { IPipelineEffect } from "./IPipelineEffect";

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

  encode({ encoder, srcTex, dstTex }, entry) {
    encodeReduceNoise(
      encoder,
      srcTex,
      dstTex,
      dstTex.width,
      dstTex.height,
      entry.strength,
      entry.preserveDetails,
      entry.reduceColorNoise,
      entry.sharpenDetails,
    );
  },

  Panel: ReduceNoisePanel,
};
