import type { ColorVibranceEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { ColorVibrancePanel } from "./ColorVibrancePanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

type ColorVibranceOp = Extract<EffectRenderOp, { kind: "color-vibrance" }>;

export const ColorVibranceEffect: IPipelineEffect<
  ColorVibranceEffectLayer,
  ColorVibranceOp
> = {
  id: "color-vibrance",
  label: "Color Vibrance…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: { vibrance: 0, saturation: 0 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "color-vibrance",
      layerId: layer.id,
      vibrance: layer.params.vibrance,
      saturation: layer.params.saturation,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const params = new Float32Array([entry.vibrance, entry.saturation, 0, 0]);
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("vib", "fs_color_vibrance", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      params.buffer as ArrayBuffer,
      entry.selMaskLayer,
    );
  },

  Panel: ColorVibrancePanel,
};
