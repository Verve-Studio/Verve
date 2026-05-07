import type { ColorTemperatureAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { ColorTemperaturePanel } from "@/ux/windows/adjustments/ColorTemperaturePanel/ColorTemperaturePanel";
import type { IPipelineEffect } from "./IPipelineEffect";

type ColorTemperatureOp = Extract<
  AdjustmentRenderOp,
  { kind: "color-temperature" }
>;

export const ColorTemperatureEffect: IPipelineEffect<
  ColorTemperatureAdjustmentLayer,
  ColorTemperatureOp
> = {
  id: "color-temperature",
  label: "Color Temperature…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: { temperature: 0, tint: 0 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "color-temperature",
      layerId: layer.id,
      temperature: layer.params.temperature,
      tint: layer.params.tint,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const params = new Float32Array([entry.temperature, entry.tint, 0, 0]);
    engine.encodeStdAdjRenderPass(
      encoder,
      engine.tempPipeline,
      srcTex,
      dstTex,
      format,
      params.buffer as ArrayBuffer,
      entry.selMaskLayer,
    );
  },

  Panel: ColorTemperaturePanel,
};
