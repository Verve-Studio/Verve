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
    return {
      kind: "glow",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex }, entry) {
    const { color, opacity, spread, softness, blendMode, knockout } =
      entry.params;
    // Glow is drop-shadow with offsetX/offsetY = 0; shares texCache with DropShadow.
    encodeDropShadowPass(engine.runtime, encoder, srcTex, dstTex, {
      colorR: color.r / 255,
      colorG: color.g / 255,
      colorB: color.b / 255,
      colorA: color.a / 255,
      opacity: opacity / 100,
      offsetX: 0,
      offsetY: 0,
      spread,
      softness,
      blendMode,
      knockout,
      selMaskLayer: entry.selMaskLayer,
    });
  },

  // No onFrameEnd / onDestroy here — DropShadowEffect owns the shared cache lifecycle.

  Panel: GlowOptions,
};
