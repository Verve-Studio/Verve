import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { HueSaturationPanel } from "./HueSaturationPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";


export interface HueSaturationParams {
 hue: number; saturation: number; lightness: number
}

export type HueSaturationEffectLayer = EffectLayerOf<"hue-saturation", HueSaturationParams>;

type HueSaturationOp = Extract<EffectRenderOp, { kind: "hue-saturation" }>;

export const HueSaturationEffect: IPipelineEffect<
  HueSaturationEffectLayer,
  HueSaturationOp
> = {
  id: "hue-saturation",
  label: "Hue/Saturation…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: { hue: 0, saturation: 0, lightness: 0 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "hue-saturation",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const params = new Float32Array([
      entry.params.hue,
      entry.params.saturation,
      entry.params.lightness,
      0,
    ]);
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("hs", "fs_hue_saturation", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      params.buffer as ArrayBuffer,
      entry.selMaskLayer,
    );
  },

  Panel: HueSaturationPanel,
};
