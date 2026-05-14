import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { SharpenPanel } from "./SharpenPanel";
import type { IPipelineEffect } from "../IPipelineEffect";


export type SharpenParams = Record<string, never>;

export type SharpenEffectLayer = EffectLayerOf<"sharpen", SharpenParams>;

type SharpenOp = Extract<EffectRenderOp, { kind: "sharpen" }>;

export const SharpenEffect: IPipelineEffect<SharpenEffectLayer, SharpenOp> =
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
        params: layer.params,
      };
    },

    encode({ engine, encoder, srcTex, dstTex }) {
      const rt = engine.runtime;
      const pair = rt.getRenderPipelinePair("filter-sharpen", "fs_sharpen");
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

    Panel: SharpenPanel,
  };
