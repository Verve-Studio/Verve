import type { ColorGradingWheelParams, EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { ColorGradingPanel } from "./ColorGradingPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

const ColorGradingIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    <circle cx="3" cy="6" r="1.8" />
    <circle cx="9" cy="6" r="1.8" />
    <circle cx="6" cy="3" r="1.8" />
    <circle cx="6" cy="9" r="1.8" />
  </svg>
);


export interface ColorGradingParams {
    lift: ColorGradingWheelParams;
    gamma: ColorGradingWheelParams;
    gain: ColorGradingWheelParams;
    offset: ColorGradingWheelParams;
    temp: number;
    tint: number;
    contrast: number;
    pivot: number;
    midDetail: number;
    colorBoost: number;
    shadows: number;
    highlights: number;
    saturation: number;
    hue: number;
    lumMix: number;
    /**
     * HDR-aware grading mode. When enabled, the shader drops the
     * stage-by-stage `[0,1]` clamps so scene-linear pixels above 1.0
     * survive the grade, replaces the bell-curve midtone weight with a
     * non-negative variant (the original `4·lum·(1−lum)` flips sign past
     * lum=1 and inverts the gamma stage on HDR pixels), and routes the
     * hue / saturation / vibrance stages through OKLab — an HDR-defined
     * colour space — instead of HSL, which is only well-defined for
     * inputs in `[0, 1]`. Disabled by default so SDR docs and existing
     * grades keep their calibrated look bit-for-bit.
     */
    hdrMode: boolean;
}

export type ColorGradingEffectLayer = EffectLayerOf<"color-grading", ColorGradingParams>;

type ColorGradingOp = Extract<EffectRenderOp, { kind: "color-grading" }>;

export const ColorGradingEffect: IPipelineEffect<
  ColorGradingEffectLayer,
  ColorGradingOp
> = {
  id: "color-grading",
  label: "Color Grading…",
  menu: { root: "adjustments", submenu: "adj-style" },
  defaultParams: {
    lift: { r: 0, g: 0, b: 0, master: 0 },
    gamma: { r: 0, g: 0, b: 0, master: 0 },
    gain: { r: 0, g: 0, b: 0, master: 0 },
    offset: { r: 0, g: 0, b: 0, master: 0 },
    temp: 6500,
    tint: 0,
    contrast: 1.0,
    pivot: 0.435,
    midDetail: 0,
    colorBoost: 0,
    shadows: 0,
    highlights: 0,
    saturation: 50,
    hue: 50,
    lumMix: 0,
    hdrMode: false,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "color-grading",
      layerId: layer.id,
      params: layer.params,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const { lift, gamma, gain, offset } = entry.params;
    const buf = new ArrayBuffer(128);
    const f = new Float32Array(buf);
    f[0] = lift.r;
    f[1] = lift.g;
    f[2] = lift.b;
    f[3] = lift.master;
    f[4] = gamma.r;
    f[5] = gamma.g;
    f[6] = gamma.b;
    f[7] = gamma.master;
    f[8] = gain.r;
    f[9] = gain.g;
    f[10] = gain.b;
    f[11] = gain.master;
    f[12] = offset.r;
    f[13] = offset.g;
    f[14] = offset.b;
    f[15] = offset.master;
    f[16] = entry.params.temp;
    f[17] = entry.params.tint;
    f[18] = entry.params.contrast;
    f[19] = entry.params.pivot;
    f[20] = entry.params.midDetail;
    f[21] = entry.params.colorBoost;
    f[22] = entry.params.shadows;
    f[23] = entry.params.highlights;
    f[24] = entry.params.saturation;
    f[25] = entry.params.hue;
    f[26] = entry.params.lumMix;
    // `inputIsLinear`: tell the shader whether the composite ping-pong it's
    // sampling holds scene-linear floats (rgba32f docs) or sRGB-encoded
    // bytes (rgba8 docs). The grading math was authored for perceptual
    // inputs; the shader gamma-encodes/decodes around its body when this
    // flag is set so the same slider numbers produce the same look in
    // either pixel format.
    const isLinear =
      format === "rgba16float" || format === "rgba32float";
    f[27] = isLinear ? 1 : 0;
    // `hdrMode`: when on, the shader runs its dedicated HDR grading path
    // (no clamps, OKLab for hue/sat, weight-luminance clamped so wMid
    // doesn't go negative on HDR pixels). User-controlled — see the
    // ColorGradingPanel toggle. Defaults to off so existing SDR grades
    // round-trip bit-for-bit.
    f[28] = entry.params.hdrMode ? 1 : 0;

    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair(
        "cg",
        "fs_color_grading",
        STD_BINDINGS,
      ),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: ColorGradingPanel,
  icon: ColorGradingIcon,
};
