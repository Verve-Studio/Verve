import type { OffsetEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { OffsetPanel } from "./OffsetPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type OffsetOp = Extract<EffectRenderOp, { kind: "offset" }>;

export const OffsetEffect: IPipelineEffect<OffsetEffectLayer, OffsetOp> = {
  id: "offset",
  label: "Offset…",
  menu: { root: "filters", submenu: "other" },
  defaultParams: { offsetX: 0, offsetY: 0 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "offset",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const pair = rt.getRenderPipelinePair("filter-offset", "fs_offset");
    const data = new Int32Array([
      Math.round(entry.params.offsetX) | 0,
      Math.round(entry.params.offsetY) | 0,
      0,
      0,
    ]);
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
