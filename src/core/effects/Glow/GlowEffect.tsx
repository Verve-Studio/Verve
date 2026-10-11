import type { EffectLayerOf, RGBAColor } from "@/types";
import { colorForTarget } from "@/core/effects/_shared/effectColor";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { GlowOptions } from "./GlowOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { boolField, customField, enumField, numberField } from "../_shared/effectParams";
import { encodeDropShadowPass } from "../DropShadow/DropShadowEffect";

const GlowIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.1"
    aria-hidden="true"
  >
    <circle
      cx="6"
      cy="6"
      r="1.5"
      fill="currentColor"
      stroke="none"
      opacity="0.9"
    />
    <circle cx="6" cy="6" r="3" opacity="0.55" />
    <circle cx="6" cy="6" r="4.8" opacity="0.25" />
  </svg>
);


export interface GlowParams {
    /** Glow color including alpha channel. r/g/b/a are 0–255. Default: { r:255, g:255, b:153, a:255 } */
    color: RGBAColor;
    /** Overall glow opacity, 0–100 (%). Applied on top of color.a. Default: 75 */
    opacity: number;
    /** Morphological dilation radius in pixels, 0–100. Default: 0 */
    spread: number;
    /** Gaussian blur radius in pixels, 0–100. Default: 15 */
    softness: number;
    /** How the glow composites with layers beneath it. Default: 'normal' */
    blendMode: "normal" | "multiply" | "screen";
    /** When true, the glow is masked by the inverse of the source alpha (outer glow only). Default: true */
    knockout: boolean;
}

export type GlowEffectLayer = EffectLayerOf<"glow", GlowParams>;

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
  paramFields: [
    // The panel edits the colour's RGB only; color.a is preserved.
    customField<GlowParams>({
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
    enumField("blendMode", "Blend Mode", [
      ["normal", "Normal"],
      ["multiply", "Multiply"],
      ["screen", "Screen"],
    ]),
    boolField("knockout", "Knockout"),
  ],

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
    const col = colorForTarget(color, dstTex.format);
    encodeDropShadowPass(engine.runtime, encoder, srcTex, dstTex, {
      colorR: col.r,
      colorG: col.g,
      colorB: col.b,
      colorA: col.a,
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
  icon: GlowIcon,
};
