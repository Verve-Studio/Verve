import type React from "react";
import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { SharpenPanel } from "../Sharpen/SharpenPanel";
import type { IPipelineEffect, PanelProps } from "../IPipelineEffect";


export type SharpenMoreParams = Record<string, never>;

export type SharpenMoreEffectLayer = EffectLayerOf<"sharpen-more", SharpenMoreParams>;

type SharpenMoreOp = Extract<EffectRenderOp, { kind: "sharpen-more" }>;

// SharpenPanel is shared — it accepts both sharpen and sharpen-more layers.
const SharpenMorePanel = SharpenPanel as unknown as React.ComponentType<
  PanelProps<SharpenMoreEffectLayer>
>;

export const SharpenMoreEffect: IPipelineEffect<
  SharpenMoreEffectLayer,
  SharpenMoreOp
> = {
  id: "sharpen-more",
  label: "Sharpen More",
  menu: { root: "filters", submenu: "sharpen", instant: true },
  defaultParams: {},

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "sharpen-more",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex }) {
    const rt = engine.runtime;
    const pair = rt.getRenderPipelinePair("filter-sharpen-more", "fs_sharpen_more");
    const isLinear =
      dstTex.format === "rgba16float" || dstTex.format === "rgba32float";
    const paramsBuf = rt.makeParamsBuf(
      new Uint32Array([isLinear ? 1 : 0, 0, 0, 0]),
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

  Panel: SharpenMorePanel,
};
