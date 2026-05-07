import type { BrightnessContrastAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { BrightnessContrastPanel } from "./BrightnessContrastPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

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
    engine.encodeStdAdjRenderPass(
      encoder,
      engine.bcPipeline,
      srcTex,
      dstTex,
      format,
      params.buffer as ArrayBuffer,
      entry.selMaskLayer,
    );
  },

  Panel: BrightnessContrastPanel,
};
