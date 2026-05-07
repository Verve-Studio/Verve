import type { ColorKeyEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { ColorKeyPanel } from "./ColorKeyPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

type ColorKeyOp = Extract<EffectRenderOp, { kind: "color-key" }>;

export const ColorKeyEffect: IPipelineEffect<
  ColorKeyEffectLayer,
  ColorKeyOp
> = {
  id: "color-key",
  label: "Color Key…",
  menu: { root: "effects", submenu: "fx-color" },
  defaultParams: {
    keyColor: { r: 0, g: 255, b: 0 },
    tolerance: 0,
    softness: 0,
    dilation: 0,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "color-key",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const { r, g, b } = entry.params.keyColor;
    const params = new Float32Array([
      r / 255,
      g / 255,
      b / 255,
      entry.params.tolerance,
      entry.params.softness,
      entry.params.dilation,
      0,
      0,
    ]);
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("ck", "fs_color_key", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      params.buffer as ArrayBuffer,
      entry.selMaskLayer,
    );
  },

  Panel: ColorKeyPanel,
};
