import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { ColorTemperaturePanel } from "./ColorTemperaturePanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

const ColorTemperatureIcon = (
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
    <line x1="6" y1="1" x2="6" y2="7" />
    <circle cx="6" cy="9" r="2" />
    <line x1="8.5" y1="2" x2="10" y2="2" />
    <line x1="8.5" y1="4" x2="9.5" y2="4" />
    <line x1="8.5" y1="6" x2="10" y2="6" />
  </svg>
);


export interface ColorTemperatureParams {
    temperature: number;
    tint: number;
}

export type ColorTemperatureEffectLayer = EffectLayerOf<"color-temperature", ColorTemperatureParams>;

type ColorTemperatureOp = Extract<
  EffectRenderOp,
  { kind: "color-temperature" }
>;

export const ColorTemperatureEffect: IPipelineEffect<
  ColorTemperatureEffectLayer,
  ColorTemperatureOp
> = {
  id: "color-temperature",
  label: "Color Temperature…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: { temperature: 0, tint: 0 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "color-temperature",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const params = new Float32Array([entry.params.temperature, entry.params.tint, 0, 0]);
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("temp", "fs_color_temperature", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      params.buffer as ArrayBuffer,
      entry.selMaskLayer,
    );
  },

  Panel: ColorTemperaturePanel,
  icon: ColorTemperatureIcon,
};
