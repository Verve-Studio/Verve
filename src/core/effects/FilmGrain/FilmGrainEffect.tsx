import type { FilmGrainAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { encodeFilmGrain } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { FilmGrainPanel } from "./FilmGrainPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type FilmGrainOp = Extract<AdjustmentRenderOp, { kind: "film-grain" }>;

export const FilmGrainEffect: IPipelineEffect<
  FilmGrainAdjustmentLayer,
  FilmGrainOp
> = {
  id: "film-grain",
  label: "Film Grain…",
  menu: { root: "filters", submenu: "noise" },
  defaultParams: { grainSize: 1, intensity: 25, roughness: 50, seed: 0 },

  buildPlanEntry(layer, { mask }) {
    const { grainSize, intensity, roughness, seed } = layer.params;
    return {
      kind: "film-grain",
      layerId: layer.id,
      grainSize,
      intensity,
      roughness,
      seed,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex }, entry) {
    encodeFilmGrain(
      encoder,
      srcTex,
      dstTex,
      dstTex.width,
      dstTex.height,
      entry.grainSize,
      entry.intensity,
      entry.roughness,
      entry.seed,
    );
  },

  Panel: FilmGrainPanel,
};
