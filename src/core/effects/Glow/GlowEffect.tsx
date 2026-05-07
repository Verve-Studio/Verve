import type { GlowEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { GlowOptions } from "./GlowOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { encodeDropShadowPass } from "../DropShadow/DropShadowEffect";

type GlowOp = Extract<EffectRenderOp, { kind: "glow" }>;

export const GlowEffect: IPipelineEffect<GlowEffectLayer, GlowOp> = {
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
    // Glow is drop-shadow with offsetX/offsetY = 0; shares texCache with DropShadow.
    encodeDropShadowPass(engine.runtime, encoder, srcTex, dstTex, {
      colorR: entry.colorR,
      colorG: entry.colorG,
      colorB: entry.colorB,
      colorA: entry.colorA,
      opacity: entry.opacity,
      offsetX: 0,
      offsetY: 0,
      spread: entry.spread,
      softness: entry.softness,
      blendMode: entry.blendMode,
      knockout: entry.knockout,
      selMaskLayer: entry.selMaskLayer,
    });
  },

  // No onFrameEnd / onDestroy here — DropShadowEffect owns the shared cache lifecycle.

  Panel: GlowOptions,
};
