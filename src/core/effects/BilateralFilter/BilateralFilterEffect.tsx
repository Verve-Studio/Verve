import type { BilateralFilterEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { BilateralFilterPanel } from "./BilateralFilterPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type BilateralFilterOp = Extract<
  EffectRenderOp,
  { kind: "bilateral-filter" }
>;

export const BilateralFilterEffect: IPipelineEffect<
  BilateralFilterEffectLayer,
  BilateralFilterOp
> = {
  id: "bilateral-filter",
  label: "Bilateral Filter…",
  menu: { root: "filters", submenu: "noise" },
  defaultParams: { radius: 5, sigmaSpatial: 10, sigmaColor: 30 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "bilateral-filter",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const pair = rt.getRenderPipelinePair("filter-bilateral", "fs_bilateral");
    const { radius, sigmaSpatial, sigmaColor } = entry.params;
    const buf = new ArrayBuffer(16);
    const dv = new DataView(buf);
    dv.setUint32(0, radius, true);
    dv.setUint32(4, 0, true);
    dv.setFloat32(8, sigmaSpatial, true);
    dv.setFloat32(12, sigmaColor, true);
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

  Panel: BilateralFilterPanel,
};
