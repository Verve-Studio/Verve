import type { BoxBlurAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeBoxBlur } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { BoxBlurPanel } from "./BoxBlurPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type BoxBlurOp = Extract<AdjustmentRenderOp, { kind: "box-blur" }>;

export const BoxBlurEffect: IPipelineEffect<BoxBlurAdjustmentLayer, BoxBlurOp> =
  {
    id: "box-blur",
    label: "Box Blur…",
    menu: { root: "filters", submenu: "blur" },
    defaultParams: { radius: 5 },

    buildPlanEntry(layer, { mask }) {
      return {
        kind: "box-blur",
        layerId: layer.id,
        radius: layer.params.radius,
        visible: layer.visible,
        selMaskLayer: mask,
      };
    },

    encode({ encoder, srcTex, dstTex }, entry) {
      encodeBoxBlur(
        encoder,
        srcTex,
        dstTex,
        dstTex.width,
        dstTex.height,
        entry.radius,
      );
    },

    Panel: BoxBlurPanel,
  };
