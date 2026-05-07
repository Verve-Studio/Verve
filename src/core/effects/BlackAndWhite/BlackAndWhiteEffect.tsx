import type { BlackAndWhiteAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { BlackAndWhitePanel } from "@/ux/windows/adjustments/BlackAndWhitePanel/BlackAndWhitePanel";
import type { IPipelineEffect } from "./IPipelineEffect";

type BlackAndWhiteOp = Extract<AdjustmentRenderOp, { kind: "black-and-white" }>;

export const BlackAndWhiteEffect: IPipelineEffect<
  BlackAndWhiteAdjustmentLayer,
  BlackAndWhiteOp
> = {
  id: "black-and-white",
  label: "Black and White…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: {
    reds: 40,
    yellows: 60,
    greens: 40,
    cyans: 60,
    blues: 20,
    magentas: 80,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "black-and-white",
      layerId: layer.id,
      params: layer.params,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const p = entry.params;
    const params = new Float32Array([
      p.reds,
      p.yellows,
      p.greens,
      p.cyans,
      p.blues,
      p.magentas,
      0,
      0,
    ]);
    engine.encodeStdAdjRenderPass(
      encoder,
      engine.bwPipeline,
      srcTex,
      dstTex,
      format,
      params.buffer as ArrayBuffer,
      entry.selMaskLayer,
    );
  },

  Panel: BlackAndWhitePanel,
};
