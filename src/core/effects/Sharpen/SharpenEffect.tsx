import type { SharpenAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeSharpen } from "@/graphicspipeline/webgpu/compute/filterCompute";
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

    encode({ encoder, srcTex, dstTex }) {
      encodeSharpen(encoder, srcTex, dstTex, dstTex.width, dstTex.height);
    },

    Panel: SharpenPanel,
  };
