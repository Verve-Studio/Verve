import type { DropShadowAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { DropShadowOptions } from "./DropShadowOptions";
import type { IPipelineEffect } from "../IPipelineEffect";

type DropShadowOp = Extract<AdjustmentRenderOp, { kind: "drop-shadow" }>;

export const DropShadowEffect: IPipelineEffect<
  DropShadowAdjustmentLayer,
  DropShadowOp
> = {
  id: "drop-shadow",
  label: "Drop Shadow…",
  menu: { root: "effects", submenu: "fx-shadow" },
  defaultParams: {
    color: { r: 0, g: 0, b: 0, a: 255 },
    opacity: 75,
    offsetX: 5,
    offsetY: 5,
    spread: 0,
    softness: 10,
    blendMode: "multiply",
    knockout: true,
  },

  buildPlanEntry(layer, { mask }) {
    const {
      color,
      opacity,
      offsetX,
      offsetY,
      spread,
      softness,
      blendMode,
      knockout,
    } = layer.params;
    return {
      kind: "drop-shadow",
      layerId: layer.id,
      colorR: color.r / 255,
      colorG: color.g / 255,
      colorB: color.b / 255,
      colorA: color.a / 255,
      opacity: opacity / 100,
      offsetX,
      offsetY,
      spread,
      softness,
      blendMode,
      knockout,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex }, entry) {
    engine.encodeDropShadowPass(
      encoder,
      srcTex,
      dstTex,
      entry.colorR,
      entry.colorG,
      entry.colorB,
      entry.colorA,
      entry.opacity,
      entry.offsetX,
      entry.offsetY,
      entry.spread,
      entry.softness,
      entry.blendMode,
      entry.knockout,
      entry.selMaskLayer,
    );
  },

  Panel: DropShadowOptions,
};
