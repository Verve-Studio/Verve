import type { SmartSharpenAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeSmartSharpen } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { SmartSharpenPanel } from "./SmartSharpenPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type SmartSharpenOp = Extract<AdjustmentRenderOp, { kind: "smart-sharpen" }>;

export const SmartSharpenEffect: IPipelineEffect<
  SmartSharpenAdjustmentLayer,
  SmartSharpenOp
> = {
  id: "smart-sharpen",
  label: "Smart Sharpen…",
  menu: { root: "filters", submenu: "sharpen" },
  defaultParams: {
    amount: 100,
    radius: 3,
    reduceNoise: 0,
    remove: "gaussian",
  },

  buildPlanEntry(layer, { mask }) {
    const { amount, radius, reduceNoise, remove } = layer.params;
    return {
      kind: "smart-sharpen",
      layerId: layer.id,
      amount,
      radius,
      reduceNoise,
      remove: remove === "gaussian" ? 0 : 1,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex }, entry) {
    encodeSmartSharpen(
      encoder,
      srcTex,
      dstTex,
      dstTex.width,
      dstTex.height,
      entry.amount,
      entry.radius,
      entry.reduceNoise,
      entry.remove,
    );
  },

  Panel: SmartSharpenPanel,
};
