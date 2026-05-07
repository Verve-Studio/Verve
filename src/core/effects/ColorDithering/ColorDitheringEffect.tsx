import type { ColorDitheringAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { ColorDitheringPanel } from "@/ux/windows/adjustments/ColorDitheringPanel/ColorDitheringPanel";
import type { IPipelineEffect } from "./IPipelineEffect";

type ColorDitheringOp = Extract<AdjustmentRenderOp, { kind: "color-dithering" }>;

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
  ColorDitheringAdjustmentLayer,
  ColorDitheringOp
> = {
  id: "color-dithering",
  label: "Color Dithering…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: { style: "bayer4", opacity: 100 },

  buildPlanEntry(layer, { mask, swatches }) {
    const style = STYLE_MAP[layer.params.style] ?? 0;
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
      palette,
      paletteCount,
      style,
      opacity: layer.params.opacity ?? 100,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    engine.encodeColorDitheringRenderPass(
      encoder,
      srcTex,
      dstTex,
      format,
      entry.palette,
      entry.paletteCount,
      entry.style,
      entry.opacity,
      entry.selMaskLayer,
    );
  },

  Panel: ColorDitheringPanel,
};
