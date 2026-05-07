import type { OffsetAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
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

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const pair = rt.getRenderPipelinePair("filter-offset", "fs_offset");
    const data = new Int32Array([entry.offsetX | 0, entry.offsetY | 0, 0, 0]);
    const paramsBuf = rt.makeParamsBuf(
      new Uint32Array(data.buffer, data.byteOffset, data.length),
    );
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

  Panel: OffsetPanel,
};
