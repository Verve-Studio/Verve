import type { ReduceColorsAdjustmentLayer, RGBAColor } from "@/types";
import type { AdjustmentRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { ReduceColorsPanel } from "./ReduceColorsPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";
import { createStorageBuffer } from "@/graphics/webgpu/utils";

type ReduceColorsOp = Extract<AdjustmentRenderOp, { kind: "reduce-colors" }>;

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

function linearSrgbToOklab(
  r: number,
  g: number,
  b: number,
): { L: number; a: number; b: number } {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(Math.max(l, 0));
  const m_ = Math.cbrt(Math.max(m, 0));
  const s_ = Math.cbrt(Math.max(s, 0));
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

export const ReduceColorsEffect: IPipelineEffect<
  ReduceColorsAdjustmentLayer,
  ReduceColorsOp
> = {
  id: "reduce-colors",
  label: "Reduce Colors…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: { mode: "reduce", colorCount: 16, derivedPalette: null },

  buildPlanEntry(layer, { mask, swatches }) {
    const { mode, derivedPalette } = layer.params;
    const sourceColors: RGBAColor[] =
      mode === "reduce"
        ? (derivedPalette ?? [])
        : swatches.length >= 2
          ? swatches
          : [];

    const paletteCount = Math.min(sourceColors.length, 256);
    const palette = new Float32Array(256 * 4);
    for (let i = 0; i < paletteCount; i++) {
      const { r, g, b } = sourceColors[i];
      const lin = srgbByteToLinear(r, g, b);
      const lab = linearSrgbToOklab(lin.r, lin.g, lin.b);
      palette[i * 4 + 0] = lab.L;
      palette[i * 4 + 1] = lab.a;
      palette[i * 4 + 2] = lab.b;
      palette[i * 4 + 3] = 0;
    }
    return {
      kind: "reduce-colors",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      palette,
      paletteCount,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const { runtime } = engine;
    const pair = runtime.getRenderPipelinePair("rc", "fs_reduce_colors", [
      ...STD_BINDINGS,
      "storage",
    ]);
    const pipeline = runtime.selectPipeline(pair, format);

    const paramsData = new Uint32Array(8);
    paramsData[0] = entry.paletteCount;
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

  Panel: ReduceColorsPanel,
};
