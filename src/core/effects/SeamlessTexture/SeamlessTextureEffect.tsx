import type { SeamlessTextureAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeSeamlessTexture } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { SeamlessTexturePanel } from "@/ux/windows/filters/SeamlessTexturePanel/SeamlessTexturePanel";
import type { IPipelineEffect } from "./IPipelineEffect";

type SeamlessTextureOp = Extract<
  AdjustmentRenderOp,
  { kind: "seamless-texture" }
>;

export const SeamlessTextureEffect: IPipelineEffect<
  SeamlessTextureAdjustmentLayer,
  SeamlessTextureOp
> = {
  id: "seamless-texture",
  label: "Seamless Texture…",
  menu: { root: "filters", submenu: "texture" },
  defaultParams: {
    breakRepetition: true,
    cellSize: 128,
    blendRadius: 16,
    seamlessBorders: true,
    borderRadius: 32,
    seed: 0,
  },

  buildPlanEntry(layer, { mask }) {
    const {
      breakRepetition,
      cellSize,
      blendRadius,
      seamlessBorders,
      borderRadius,
      seed,
    } = layer.params;
    return {
      kind: "seamless-texture",
      layerId: layer.id,
      breakRepetition,
      cellSize,
      blendRadius,
      seamlessBorders,
      borderRadius,
      seed,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex }, entry) {
    encodeSeamlessTexture(
      encoder,
      srcTex,
      dstTex,
      dstTex.width,
      dstTex.height,
      entry.breakRepetition,
      entry.cellSize,
      entry.blendRadius,
      entry.seamlessBorders,
      entry.borderRadius,
      entry.seed,
    );
  },

  Panel: SeamlessTexturePanel,
};
