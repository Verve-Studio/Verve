import type { InnerShadowAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { InnerShadowOptions } from "@/ux/windows/effects/InnerShadowOptions/InnerShadowOptions";
import type { IPipelineEffect } from "./IPipelineEffect";

type InnerShadowOp = Extract<AdjustmentRenderOp, { kind: "inner-shadow" }>;

export const InnerShadowEffect: IPipelineEffect<
  InnerShadowAdjustmentLayer,
  InnerShadowOp
> = {
  id: "inner-shadow",
  label: "Inner Shadow…",
  menu: { root: "effects", submenu: "fx-shadow" },
  defaultParams: {
    color: { r: 0, g: 0, b: 0, a: 255 },
    opacity: 75,
    offsetX: 5,
    offsetY: 5,
    spread: 0,
    softness: 10,
  },

  buildPlanEntry(layer, { mask }) {
    const { color, opacity, offsetX, offsetY, spread, softness } = layer.params;
    return {
      kind: "inner-shadow",
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
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex }, entry) {
    engine.encodeInnerShadowPass(
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
      entry.selMaskLayer,
    );
  },

  Panel: InnerShadowOptions,
};
