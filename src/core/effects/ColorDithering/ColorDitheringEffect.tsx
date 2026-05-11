import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { ColorDitheringPanel } from "./ColorDitheringPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";
import { createStorageBuffer } from "@/graphics/webgpu/utils";

const ColorDitheringIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="currentColor"
    aria-hidden="true"
  >
    <rect x="0" y="0" width="3" height="3" />
    <rect x="6" y="0" width="3" height="3" />
    <rect x="3" y="3" width="3" height="3" />
    <rect x="9" y="3" width="3" height="3" />
    <rect x="0" y="6" width="3" height="3" />
    <rect x="6" y="6" width="3" height="3" />
    <rect x="3" y="9" width="3" height="3" />
    <rect x="9" y="9" width="3" height="3" />
  </svg>
);


export interface ColorDitheringParams {
    style: "bayer4" | "bayer8";
    opacity: number;
}

export type ColorDitheringEffectLayer = EffectLayerOf<"color-dithering", ColorDitheringParams>;

type ColorDitheringOp = Extract<EffectRenderOp, { kind: "color-dithering" }>;

const STYLE_MAP: Record<string, number> = {
  bayer4: 0,
  bayer8: 1,
};

function srgbByteToLinear(
  r: number,
  g: number,
  b: number,
): { r: number; g: number; b: number } {
  const toLinear = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return { r: toLinear(r), g: toLinear(g), b: toLinear(b) };
}

export const ColorDitheringEffect: IPipelineEffect<
  ColorDitheringEffectLayer,
  ColorDitheringOp
> = {
  id: "color-dithering",
  label: "Color Dithering…",
  menu: { root: "adjustments", submenu: "adj-indexed" },
  defaultParams: { style: "bayer4", opacity: 100 },

  buildPlanEntry(layer, { mask, swatches }) {
    const paletteCount = Math.min(swatches.length, 256);
    const palette = new Float32Array(256 * 4);
    for (let i = 0; i < paletteCount; i++) {
      const { r, g, b } = swatches[i];
      const lin = srgbByteToLinear(r, g, b);
      palette[i * 4 + 0] = lin.r;
      palette[i * 4 + 1] = lin.g;
      palette[i * 4 + 2] = lin.b;
      palette[i * 4 + 3] = 0;
    }
    return {
      kind: "color-dithering",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
      palette,
      paletteCount,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const { runtime } = engine;
    const pair = runtime.getRenderPipelinePair(
      "dither",
      "fs_color_dithering",
      [...STD_BINDINGS, "storage"],
    );
    const pipeline = runtime.selectPipeline(pair, format);

    const style = STYLE_MAP[entry.params.style] ?? 0;
    const paramsData = new Uint32Array(8);
    paramsData[0] = entry.paletteCount;
    paramsData[1] = style;
    paramsData[2] = Math.round(entry.params.opacity ?? 100);
    const paramsBuf = runtime.makeParamsBuf(paramsData);

    const palBuf = createStorageBuffer(runtime.device, 256 * 16);
    runtime.device.queue.writeBuffer(
      palBuf,
      0,
      entry.palette as Float32Array<ArrayBuffer>,
    );
    runtime.pendingDestroyBuffers.push(palBuf);

    const maskFlagsBuf = runtime.makeMaskFlagsBuf(!!entry.selMaskLayer);
    const dummyMask = entry.selMaskLayer?.texture ?? srcTex;

    runtime.encodeRenderPass(encoder, pipeline, dstTex, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: runtime.adjSampler },
      { binding: 2, resource: { buffer: paramsBuf } },
      { binding: 3, resource: dummyMask.createView() },
      { binding: 4, resource: { buffer: maskFlagsBuf } },
      { binding: 5, resource: { buffer: palBuf } },
    ], pair.bgl);
  },

  Panel: ColorDitheringPanel,
  icon: ColorDitheringIcon,
};
