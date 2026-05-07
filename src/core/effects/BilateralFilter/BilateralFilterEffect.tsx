import type { BilateralFilterAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { getFilterRuntime } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { BilateralFilterPanel } from "./BilateralFilterPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

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
    const rt = getFilterRuntime();
    const pair = rt.getPipelinePair("filter-bilateral", "fs_bilateral");
    const buf = new ArrayBuffer(16);
    const dv = new DataView(buf);
    dv.setUint32(0, entry.radius, true);
    dv.setUint32(4, 0, true);
    dv.setFloat32(8, entry.sigmaSpatial, true);
    dv.setFloat32(12, entry.sigmaColor, true);
    const paramsBuf = rt.makeParamsBuf(buf);
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(pair, dstTex),
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
      ],
      dstTex,
    );
  },

  Panel: BilateralFilterPanel,
};
