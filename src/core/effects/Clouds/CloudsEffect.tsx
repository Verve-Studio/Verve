import type { CloudsAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeClouds } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { CloudsPanel } from "./CloudsPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type CloudsOp = Extract<AdjustmentRenderOp, { kind: "clouds" }>;

export const CloudsEffect: IPipelineEffect<CloudsAdjustmentLayer, CloudsOp> = {
  id: "clouds",
  label: "Clouds…",
  menu: { root: "filters", submenu: "render" },
  defaultParams: {
    scale: 100,
    opacity: 100,
    colorMode: "grayscale",
    fgR: 0,
    fgG: 0,
    fgB: 0,
    bgR: 255,
    bgG: 255,
    bgB: 255,
    seed: 0,
  },

  buildPlanEntry(layer, { mask }) {
    const { scale, opacity, colorMode, fgR, fgG, fgB, bgR, bgG, bgB, seed } =
      layer.params;
    const fgColor = (fgR | (fgG << 8) | (fgB << 16)) >>> 0;
    const bgColor = (bgR | (bgG << 8) | (bgB << 16)) >>> 0;
    return {
      kind: "clouds",
      layerId: layer.id,
      scale,
      opacity,
      colorMode: colorMode === "color" ? 1 : 0,
      fgColor,
      bgColor,
      seed,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex }, entry) {
    encodeClouds(
      encoder,
      srcTex,
      dstTex,
      dstTex.width,
      dstTex.height,
      entry.scale,
      entry.opacity,
      entry.colorMode,
      entry.fgColor,
      entry.bgColor,
      entry.seed,
    );
  },

  Panel: CloudsPanel,
};
