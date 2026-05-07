import type { BrightnessContrastAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { BrightnessContrastPanel } from "./BrightnessContrastPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphicspipeline/webgpu/EffectRuntime";

type BrightnessContrastOp = Extract<
  AdjustmentRenderOp,
  { kind: "brightness-contrast" }
>;

export const BrightnessContrastEffect: IPipelineEffect<
  BrightnessContrastAdjustmentLayer,
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
      brightness: layer.params.brightness,
      contrast: layer.params.contrast,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const params = new Float32Array([entry.brightness, entry.contrast, 0, 0]);
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
