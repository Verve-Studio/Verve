import type React from "react";
import type { SharpenMoreEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { SharpenPanel } from "../Sharpen/SharpenPanel";
import type { IPipelineEffect, PanelProps } from "../IPipelineEffect";

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
    };
  },

  encode({ engine, encoder, srcTex, dstTex }) {
    const rt = engine.runtime;
    const pair = rt.getRenderPipelinePair("filter-sharpen-more", "fs_sharpen_more");
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(pair, dstTex),
      dstTex,
      [{ binding: 0, resource: srcTex.createView() }],
    );
  },

  Panel: SharpenMorePanel,
};
