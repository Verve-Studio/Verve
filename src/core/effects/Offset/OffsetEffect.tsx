import type { OffsetAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeOffset } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { OffsetPanel } from "./OffsetPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type OffsetOp = Extract<AdjustmentRenderOp, { kind: "offset" }>;

export const OffsetEffect: IPipelineEffect<OffsetAdjustmentLayer, OffsetOp> = {
  id: "offset",
  label: "Offset…",
  menu: { root: "filters", submenu: "other" },
  defaultParams: { offsetX: 0, offsetY: 0 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "offset",
      layerId: layer.id,
      offsetX: Math.round(layer.params.offsetX),
      offsetY: Math.round(layer.params.offsetY),
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex }, entry) {
    encodeOffset(
      encoder,
      srcTex,
      dstTex,
      dstTex.width,
      dstTex.height,
      entry.offsetX,
      entry.offsetY,
    );
  },

  Panel: OffsetPanel,
};
