import type { EffectLayerOf, RGBAColor } from "@/types";
import { colorForTarget } from "@/core/effects/_shared/effectColor";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { InnerGlowOptions } from "./InnerGlowOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { customField, numberField } from "../_shared/effectParams";
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
  paramFields: [
    // The panel edits the colour's RGB only; color.a is preserved.
    customField<InnerGlowParams>({
      id: "color",
      label: "Color",
      spec: { kind: "color" },
      get: (p) => [p.color.r / 255, p.color.g / 255, p.color.b / 255, 1],
      set: (p, v) => {
        const c = Array.isArray(v) ? (v as readonly number[]) : [0, 0, 0];
        const b = (x: number | undefined): number =>
          Math.round(Math.min(1, Math.max(0, x ?? 0)) * 255);
        return { ...p, color: { r: b(c[0]), g: b(c[1]), b: b(c[2]), a: p.color.a } };
      },
    }),
    numberField("opacity", "Opacity", { min: 0, max: 100, int: true }),
    numberField("spread", "Spread", { min: 0, max: 100, int: true }),
    numberField("softness", "Softness", { min: 0, max: 100, int: true }),
  ],

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
    const col = colorForTarget(color, dstTex.format);
    encodeInnerShadowPass(engine.runtime, encoder, srcTex, dstTex, {
      colorR: col.r,
      colorG: col.g,
      colorB: col.b,
      colorA: col.a,
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
