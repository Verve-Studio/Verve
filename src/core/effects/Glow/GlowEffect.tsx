import type { GlowAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { GlowOptions } from "@/ux/windows/effects/GlowOptions/GlowOptions";
import type { IPipelineEffect } from "./IPipelineEffect";

type GlowOp = Extract<AdjustmentRenderOp, { kind: "glow" }>;

export const GlowEffect: IPipelineEffect<GlowAdjustmentLayer, GlowOp> = {
  id: "glow",
  label: "Glow…",
  menu: { root: "effects", submenu: "fx-shadow" },
  defaultParams: {
    color: { r: 255, g: 255, b: 153, a: 255 },
    opacity: 75,
    spread: 0,
    softness: 15,
    blendMode: "normal",
    knockout: true,
  },

  buildPlanEntry(layer, { mask }) {
    const { color, opacity, spread, softness, blendMode, knockout } =
      layer.params;
    return {
      kind: "glow",
      layerId: layer.id,
      colorR: color.r / 255,
      colorG: color.g / 255,
      colorB: color.b / 255,
      colorA: color.a / 255,
      opacity: opacity / 100,
      spread,
      softness,
      blendMode,
      knockout,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex }, entry) {
    // Glow is drop-shadow with offsetX/offsetY = 0.
    engine.encodeDropShadowPass(
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
      entry.blendMode,
      entry.knockout,
      entry.selMaskLayer,
    );
  },

  Panel: GlowOptions,
};
