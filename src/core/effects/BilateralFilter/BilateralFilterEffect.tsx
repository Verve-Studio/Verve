import type { BilateralFilterAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeBilateral } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { BilateralFilterPanel } from "@/ux/windows/filters/BilateralFilterPanel/BilateralFilterPanel";
import type { IPipelineEffect } from "./IPipelineEffect";

type BilateralFilterOp = Extract<
  AdjustmentRenderOp,
  { kind: "bilateral-filter" }
>;

export const BilateralFilterEffect: IPipelineEffect<
  BilateralFilterAdjustmentLayer,
  BilateralFilterOp
> = {
  id: "bilateral-filter",
  label: "Bilateral Filter…",
  menu: { root: "filters", submenu: "noise" },
  defaultParams: { radius: 5, sigmaSpatial: 10, sigmaColor: 30 },

  buildPlanEntry(layer, { mask }) {
    const { radius, sigmaSpatial, sigmaColor } = layer.params;
    return {
      kind: "bilateral-filter",
      layerId: layer.id,
      radius,
      sigmaSpatial,
      sigmaColor,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex }, entry) {
    encodeBilateral(
      encoder,
      srcTex,
      dstTex,
      dstTex.width,
      dstTex.height,
      entry.radius,
      entry.sigmaSpatial,
      entry.sigmaColor,
    );
  },

  Panel: BilateralFilterPanel,
};
