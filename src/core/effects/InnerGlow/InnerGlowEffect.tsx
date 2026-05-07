import type { InnerGlowAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { InnerGlowOptions } from "@/ux/windows/effects/InnerGlowOptions/InnerGlowOptions";
import type { IPipelineEffect } from "./IPipelineEffect";

type InnerGlowOp = Extract<AdjustmentRenderOp, { kind: "inner-glow" }>;

export const InnerGlowEffect: IPipelineEffect<
  InnerGlowAdjustmentLayer,
  InnerGlowOp
> = {
  id: "inner-glow",
  label: "Inner Glow…",
  menu: { root: "effects", submenu: "fx-shadow" },
  defaultParams: {
    color: { r: 255, g: 255, b: 153, a: 255 },
    opacity: 75,
    spread: 0,
    softness: 15,
  },

  buildPlanEntry(layer, { mask }) {
    const { color, opacity, spread, softness } = layer.params;
    return {
      kind: "inner-glow",
      layerId: layer.id,
      colorR: color.r / 255,
      colorG: color.g / 255,
      colorB: color.b / 255,
      colorA: color.a / 255,
      opacity: opacity / 100,
      spread,
      softness,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex }, entry) {
    // Inner glow is inner-shadow with offsetX/offsetY = 0.
    engine.encodeInnerShadowPass(
      encoder,
      srcTex,
      dstTex,
      entry.colorR,
      entry.colorG,
      entry.colorB,
      entry.colorA,
      entry.opacity,
      0,
      0,
      entry.spread,
      entry.softness,
      entry.selMaskLayer,
    );
  },

  Panel: InnerGlowOptions,
};
