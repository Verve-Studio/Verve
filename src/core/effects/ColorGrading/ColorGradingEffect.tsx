import type { ColorGradingEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { ColorGradingPanel } from "./ColorGradingPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

type ColorGradingOp = Extract<EffectRenderOp, { kind: "color-grading" }>;

export const ColorGradingEffect: IPipelineEffect<
  ColorGradingEffectLayer,
  ColorGradingOp
> = {
  id: "color-grading",
  label: "Color Grading…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
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
    f[27] = 0;

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
};
