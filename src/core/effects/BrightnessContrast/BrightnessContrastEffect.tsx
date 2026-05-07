import type { BrightnessContrastEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { BrightnessContrastPanel } from "./BrightnessContrastPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

type BrightnessContrastOp = Extract<
  EffectRenderOp,
  { kind: "brightness-contrast" }
>;

export const BrightnessContrastEffect: IPipelineEffect<
  BrightnessContrastEffectLayer,
  BrightnessContrastOp
> = {
  id: "brightness-contrast",
  label: "Brightness/Contrast…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: { brightness: 0, contrast: 0 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "brightness-contrast",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const params = new Float32Array([entry.params.brightness, entry.params.contrast, 0, 0]);
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("bc", "fs_brightness_contrast", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      params.buffer as ArrayBuffer,
      entry.selMaskLayer,
    );
  },

  Panel: BrightnessContrastPanel,
};
