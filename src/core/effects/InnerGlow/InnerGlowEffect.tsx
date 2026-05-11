import type { EffectLayerOf, RGBAColor } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { InnerGlowOptions } from "./InnerGlowOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { encodeInnerShadowPass } from "../InnerShadow/InnerShadowEffect";


export interface InnerGlowParams {
    /** Glow color including alpha. r/g/b/a are 0–255. Default: { r:255, g:255, b:153, a:255 } */
    color: RGBAColor;
    /** Overall glow opacity, 0–100 (%). Default: 75 */
    opacity: number;
    /** Erosion radius in pixels, 0–100. Controls how far the glow spreads inward. Default: 0 */
    spread: number;
    /** Blur radius in pixels, 0–100. Controls softness of glow edges. Default: 15 */
    softness: number;
}

export type InnerGlowEffectLayer = EffectLayerOf<"inner-glow", InnerGlowParams>;

type InnerGlowOp = Extract<EffectRenderOp, { kind: "inner-glow" }>;

export const InnerGlowEffect: IPipelineEffect<
  InnerGlowEffectLayer,
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
    return {
      kind: "inner-glow",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex }, entry) {
    const { color, opacity, spread, softness } = entry.params;
    // Inner glow is inner-shadow with offsetX/offsetY = 0; shares texCache.
    encodeInnerShadowPass(engine.runtime, encoder, srcTex, dstTex, {
      colorR: color.r / 255,
      colorG: color.g / 255,
      colorB: color.b / 255,
      colorA: color.a / 255,
      opacity: opacity / 100,
      offsetX: 0,
      offsetY: 0,
      spread,
      softness,
      selMaskLayer: entry.selMaskLayer,
    });
  },

  // No onFrameEnd / onDestroy — InnerShadowEffect owns the shared cache lifecycle.

  Panel: InnerGlowOptions,
};
