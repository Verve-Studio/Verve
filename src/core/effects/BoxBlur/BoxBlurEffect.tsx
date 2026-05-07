import type { BoxBlurAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
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

    encode({ encoder, srcTex, dstTex, engine }, entry) {
      const rt = engine.runtime;
      const hPair = rt.getRenderPipelinePair("filter-box-h", "fs_box_h");
      const vPair = rt.getRenderPipelinePair("filter-box-v", "fs_box_v");
      const paramsBuf = rt.makeParamsBuf(
        new Uint32Array([entry.radius, 0, 0, 0]),
      );
      rt.encodeRenderPass(
        encoder,
        rt.selectPipeline(hPair, rt.intermediate),
        rt.intermediate,
        [
          { binding: 0, resource: srcTex.createView() },
          { binding: 2, resource: { buffer: paramsBuf } },
        ],
      );
      rt.encodeRenderPass(
        encoder,
        rt.selectPipeline(vPair, dstTex),
        dstTex,
        [
          { binding: 0, resource: rt.intermediate.createView() },
          { binding: 2, resource: { buffer: paramsBuf } },
        ],
      );
    },

    Panel: BoxBlurPanel,
  };
