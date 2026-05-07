import type { SharpenAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { SharpenPanel } from "./SharpenPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type SharpenOp = Extract<AdjustmentRenderOp, { kind: "sharpen" }>;

export const SharpenEffect: IPipelineEffect<SharpenAdjustmentLayer, SharpenOp> =
  {
    id: "sharpen",
    label: "Sharpen",
    menu: { root: "filters", submenu: "sharpen", instant: true },
    defaultParams: {},

    buildPlanEntry(layer, { mask }) {
      return {
        kind: "sharpen",
        layerId: layer.id,
        visible: layer.visible,
        selMaskLayer: mask,
      };
    },

    encode({ engine, encoder, srcTex, dstTex }) {
      const rt = engine.runtime;
      const pair = rt.getRenderPipelinePair("filter-sharpen", "fs_sharpen");
      rt.encodeRenderPass(
        encoder,
        rt.selectPipeline(pair, dstTex),
        dstTex,
        [{ binding: 0, resource: srcTex.createView() }],
      );
    },

    Panel: SharpenPanel,
  };
