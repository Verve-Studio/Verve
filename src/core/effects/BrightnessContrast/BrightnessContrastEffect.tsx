import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { BrightnessContrastPanel } from "./BrightnessContrastPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

const BrightnessContrastIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="6" cy="6" r="2" />
    <path d="M6 1v1M6 10v1M1 6h1M10 6h1M2.5 2.5l.7.7M8.8 8.8l.7.7M9.5 2.5l-.7.7M3.2 8.8l-.7.7" />
  </svg>
);


export interface BrightnessContrastParams {
 brightness: number; contrast: number
}

export type BrightnessContrastEffectLayer = EffectLayerOf<"brightness-contrast", BrightnessContrastParams>;

type BrightnessContrastOp = Extract<
  EffectRenderOp,
  { kind: "brightness-contrast" }
>;

export const BrightnessContrastEffect: IPipelineEffect<
  BrightnessContrastEffectLayer,
  BrightnessContrastOp
> = {
  id: "brightness-contrast",
  label: "Brightness/Contrast…",
  menu: { root: "adjustments", submenu: "adj-tone" },
  defaultParams: { brightness: 0, contrast: 0 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "brightness-contrast",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const isLinear = format === "rgba16float" || format === "rgba32float";
    const params = new Float32Array([
      entry.params.brightness,
      entry.params.contrast,
      isLinear ? 1 : 0,
      0,
    ]);
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("bc", "fs_brightness_contrast", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      params.buffer as ArrayBuffer,
      entry.selMaskLayer,
    );
  },

  Panel: BrightnessContrastPanel,
  icon: BrightnessContrastIcon,
};
