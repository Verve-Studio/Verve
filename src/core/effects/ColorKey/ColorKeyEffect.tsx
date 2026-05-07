import type { ColorKeyAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { ColorKeyPanel } from "./ColorKeyPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type ColorKeyOp = Extract<AdjustmentRenderOp, { kind: "color-key" }>;

export const ColorKeyEffect: IPipelineEffect<
  ColorKeyAdjustmentLayer,
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
    const { r, g, b } = layer.params.keyColor;
    return {
      kind: "color-key",
      layerId: layer.id,
      keyR: r / 255,
      keyG: g / 255,
      keyB: b / 255,
      tolerance: layer.params.tolerance,
      softness: layer.params.softness,
      dilation: layer.params.dilation,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const params = new Float32Array([
      entry.keyR,
      entry.keyG,
      entry.keyB,
      entry.tolerance,
      entry.softness,
      entry.dilation,
      0,
      0,
    ]);
    engine.encodeStdAdjRenderPass(
      encoder,
      engine.ckPipeline,
      srcTex,
      dstTex,
      format,
      params.buffer as ArrayBuffer,
      entry.selMaskLayer,
    );
  },

  Panel: ColorKeyPanel,
};
