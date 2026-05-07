import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { InvertPanel } from "./InvertPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import type { AdjBinding } from "@/graphics/webgpu/EffectRuntime";


export type ColorInvertParams = Record<never, never>;

export type ColorInvertEffectLayer = EffectLayerOf<"color-invert", ColorInvertParams>;

const INVERT_BINDINGS: AdjBinding[] = ["tex", "sampler", "tex", "uniform"];

type ColorInvertOp = Extract<EffectRenderOp, { kind: "color-invert" }>;

export const ColorInvertEffect: IPipelineEffect<
  ColorInvertEffectLayer,
  ColorInvertOp
> = {
  id: "color-invert",
  label: "Invert",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: {},

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "color-invert",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const pair = engine.runtime.getRenderPipelinePair(
      "invert",
      "fs_color_invert",
      INVERT_BINDINGS,
    );
    const pipeline = engine.runtime.selectPipeline(pair, format);
    const maskFlagsBuf = engine.runtime.makeMaskFlagsBuf(!!entry.selMaskLayer);
    const dummyMask = entry.selMaskLayer?.texture ?? srcTex;

    engine.runtime.encodeRenderPass(encoder, pipeline, dstTex, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: engine.runtime.adjSampler },
      { binding: 2, resource: dummyMask.createView() },
      { binding: 3, resource: { buffer: maskFlagsBuf } },
    ], pair.bgl);
  },

  Panel: InvertPanel,
};
